import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript-compiler';
import type { Root } from '../../../shared/types.js';
import { ok, resolveToolPath } from './common.js';

type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'const' | 'enum' | 'method' | 'property' | 'parameter' | 'import' | 'module';

export interface SymbolsInput {
  action?: 'search' | 'outline' | 'usages';
  query?: string;
  file?: string;
  line?: number;
  path?: string;
  kind?: SymbolKind;
  lang?: 'ts' | 'tsx' | 'js' | 'jsx';
  maxResults?: number;
  offset?: number;
  definitionOffset?: number;
}

interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  col: number;
  sig: string;
  memberOf?: string;
}

interface IdentifierInfo {
  name: string;
  line: number;
  col: number;
  isDecl: boolean;
  propertyName: boolean;
}

interface ImportInfo {
  from: string;
  bindings: string[];
  sources: string[];
}

interface ParsedFile {
  real: string;
  virtual: string;
  text: string;
  symbols: OutlineSymbol[];
  identifiers: IdentifierInfo[];
  imports: ImportInfo[];
  parseErrors: number;
}

// Parsing has a per-file byte circuit breaker, not a repository file-count breaker. The old
// scan/parse counts could make a definition beyond the first N candidates indistinguishable from
// "not found". Large generated/vendor trees are already excluded by directory policy.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_PAGE = 500;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'out', 'release']);
const cache = new Map<string, { mtimeMs: number; size: number; weight: number; parsed: ParsedFile }>();
let cacheBytes = 0;

function xml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extensionAllowed(file: string, lang?: SymbolsInput['lang']): boolean {
  const ext = path.extname(file).toLowerCase();
  if (lang === 'ts') return ['.ts', '.mts', '.cts'].includes(ext);
  if (lang === 'tsx') return ext === '.tsx';
  if (lang === 'js') return ['.js', '.mjs', '.cjs'].includes(ext);
  if (lang === 'jsx') return ext === '.jsx';
  return ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
}

function scriptKind(file: string): ts.ScriptKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (['.js', '.mjs', '.cjs'].includes(ext)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function position(sf: ts.SourceFile, node: ts.Node): { line: number; col: number } {
  const p = sf.getLineAndCharacterOfPosition(node.getStart(sf, false));
  return { line: p.line + 1, col: p.character + 1 };
}

function declarationName(node: ts.Node): ts.Identifier | undefined {
  if ('name' in node) {
    const name = (node as ts.NamedDeclaration).name;
    return name && ts.isIdentifier(name) ? name : undefined;
  }
  return undefined;
}

function memberOf(node: ts.Node): string | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current) || ts.isClassExpression(current)) {
      return current.name?.text;
    }
    current = current.parent;
  }
  return undefined;
}

function signature(sf: ts.SourceFile, node: ts.Node): string {
  let value = node.getText(sf).replace(/\s+/g, ' ').trim();
  const body = value.indexOf('{');
  if (body >= 0) value = value.slice(0, body).trim();
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function variableKind(node: ts.VariableDeclaration): SymbolKind {
  const list = node.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 ? 'const' : 'variable';
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isParameter(parent) || ts.isModuleDeclaration(parent)) return parent.name === node;
  if (ts.isImportSpecifier(parent)) return parent.name === node;
  if (ts.isNamespaceImport(parent)) return parent.name === node;
  if (ts.isImportClause(parent)) return parent.name === node;
  return false;
}

function isPropertyNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return Boolean(
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node)
  );
}

function collectAst(sf: ts.SourceFile): { symbols: OutlineSymbol[]; identifiers: IdentifierInfo[]; imports: ImportInfo[]; parseErrors: number } {
  const symbols: OutlineSymbol[] = [];
  const identifiers: IdentifierInfo[] = [];
  const imports: ImportInfo[] = [];

  const addSymbol = (name: ts.Identifier | undefined, kind: SymbolKind, node: ts.Node) => {
    if (!name) return;
    symbols.push({ name: name.text, kind, ...position(sf, name), sig: signature(sf, node), memberOf: memberOf(node) });
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node)) addSymbol(node.name, 'function', node);
    else if (ts.isClassDeclaration(node)) addSymbol(node.name, 'class', node);
    else if (ts.isInterfaceDeclaration(node)) addSymbol(node.name, 'interface', node);
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node.name, 'type', node);
    else if (ts.isEnumDeclaration(node)) addSymbol(node.name, 'enum', node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) addSymbol(node.name, variableKind(node), node);
    else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) addSymbol(declarationName(node), 'method', node);
    else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) addSymbol(declarationName(node), 'property', node);
    else if (ts.isParameter(node) && ts.isIdentifier(node.name)) addSymbol(node.name, 'parameter', node);
    else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) addSymbol(node.name, 'module', node);
    else if (ts.isImportSpecifier(node)) addSymbol(node.name, 'import', node);
    else if (ts.isNamespaceImport(node)) addSymbol(node.name, 'import', node);
    else if (ts.isImportClause(node) && node.name) addSymbol(node.name, 'import', node);

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings: string[] = [];
      const sources: string[] = [];
      const clause = node.importClause;
      if (clause?.name) { bindings.push(clause.name.text); sources.push('default'); }
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) { bindings.push(named.name.text); sources.push('*'); }
      if (named && ts.isNamedImports(named)) {
        for (const item of named.elements) {
          bindings.push(item.name.text);
          sources.push(item.propertyName?.text ?? item.name.text);
        }
      }
      imports.push({ from: node.moduleSpecifier.text, bindings, sources });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const bindings = node.exportClause.elements.map((item) => item.name.text);
      const sources = node.exportClause.elements.map((item) => item.propertyName?.text ?? item.name.text);
      imports.push({ from: node.moduleSpecifier.text, bindings, sources });
    }

    if (ts.isIdentifier(node)) {
      identifiers.push({
        name: node.text,
        ...position(sf, node),
        isDecl: isDeclarationIdentifier(node),
        propertyName: isPropertyNameIdentifier(node)
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const parseErrors = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0;
  return { symbols, identifiers, imports, parseErrors };
}

async function parseFile(real: string, virtual: string): Promise<ParsedFile | undefined> {
  const stat = await fs.stat(real).catch(() => undefined);
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
  const cached = cache.get(real);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // True LRU: hot files survive repository-wide symbol work instead of eviction being FIFO.
    cache.delete(real);
    cache.set(real, cached);
    return cached.parsed;
  }
  if (cached) {
    cache.delete(real);
    cacheBytes -= cached.weight;
  }
  const text = await fs.readFile(real, 'utf8');
  const sf = ts.createSourceFile(real, text, ts.ScriptTarget.Latest, true, scriptKind(real));
  const collected = collectAst(sf);
  const parsed: ParsedFile = { real, virtual, text, ...collected };
  // Conservatively account for source text plus the object-heavy symbol/reference tables. Exact
  // V8 heap size is unknowable, but this tracks the resources that actually vary instead of file count.
  const weight = stat.size * 2 + collected.symbols.length * 256 + collected.identifiers.length * 128 + collected.imports.length * 256;
  if (weight <= MAX_CACHE_BYTES) {
    cache.set(real, { mtimeMs: stat.mtimeMs, size: stat.size, weight, parsed });
    cacheBytes += weight;
    while (cacheBytes > MAX_CACHE_BYTES && cache.size > 1) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldest) cacheBytes -= oldest.weight;
    }
  }
  return parsed;
}

async function candidateFiles(roots: readonly Root[], scopeInput: string | undefined, lang?: SymbolsInput['lang']): Promise<Array<{ real: string; virtual: string }>> {
  let scope;
  if (scopeInput) scope = await resolveToolPath(roots, scopeInput);
  else if (roots.length === 1) scope = await resolveToolPath(roots, `/${roots[0]!.name}`);
  else throw new Error('symbols path is required when more than one approved root exists');
  const stat = await fs.stat(scope.real);
  if (stat.isFile()) return extensionAllowed(scope.real, lang) ? [{ real: scope.real, virtual: scope.virtual }] : [];
  if (!stat.isDirectory()) throw new Error(`symbols path is not a file or directory: ${scope.virtual}`);
  const out: Array<{ real: string; virtual: string }> = [];
  const stack = [{ real: scope.real, virtual: scope.virtual }];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = (await fs.readdir(dir.real, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const real = path.join(dir.real, entry.name);
      const virtual = `${dir.virtual}/${entry.name}`.replace(/\/{2,}/g, '/');
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push({ real, virtual });
      } else if (entry.isFile() && extensionAllowed(real, lang)) {
        out.push({ real, virtual });
      }
    }
  }
  return out;
}

function rank(query: string, name: string): number {
  if (name === query) return 0;
  if (name.toLowerCase() === query.toLowerCase()) return 1;
  if (name.toLowerCase().startsWith(query.toLowerCase())) return 2;
  if (name.toLowerCase().includes(query.toLowerCase())) return 3;
  return -1;
}

function validateQuery(query: string | undefined): string {
  if (!query?.trim()) throw new Error('symbols query is required for search/usages');
  return query.trim();
}

function resolveImport(from: string, importer: string): string[] {
  if (!from.startsWith('.')) return [];
  const base = path.resolve(path.dirname(importer), from);
  const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  return [base, ...exts.map((ext) => `${base}${ext}`), ...exts.map((ext) => path.join(base, `index${ext}`))].map((item) => process.platform === 'win32' ? item.toLowerCase() : item);
}

function normalized(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function parseCandidates(files: Array<{ real: string; virtual: string }>, query?: string): Promise<{ parsed: ParsedFile[]; skipped: number }> {
  const parsed: ParsedFile[] = [];
  let skipped = 0;
  for (const file of files) {
    if (query) {
      const stat = await fs.stat(file.real).catch(() => undefined);
      if (!stat?.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) { skipped++; continue; }
      const raw = await fs.readFile(file.real, 'utf8');
      if (!raw.toLowerCase().includes(query.toLowerCase())) continue;
    }
    const item = await parseFile(file.real, file.virtual);
    if (item) parsed.push(item); else skipped++;
  }
  return { parsed, skipped };
}

export async function symbolsTool(roots: readonly Root[], input: SymbolsInput) {
  const action = input.action ?? 'search';
  const maxResults = Math.min(Math.max(input.maxResults ?? (action === 'usages' ? 200 : 50), 1), MAX_RESULT_PAGE);
  const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset! : 0;
  const definitionOffset = Number.isSafeInteger(input.definitionOffset) && (input.definitionOffset ?? 0) >= 0 ? input.definitionOffset! : 0;

  if (action === 'outline') {
    if (!input.file) throw new Error('symbols outline requires file');
    const resolved = await resolveToolPath(roots, input.file);
    if (!extensionAllowed(resolved.real, input.lang)) throw new Error('symbols outline supports TS/TSX/JS/JSX family files');
    const parsed = await parseFile(resolved.real, resolved.virtual);
    if (!parsed) throw new Error(`File is missing or exceeds ${MAX_FILE_BYTES} bytes: ${resolved.virtual}`);
    const all = parsed.symbols.filter((item) => item.kind !== 'parameter');
    const top = all.slice(offset, offset + maxResults);
    const groups = new Map<SymbolKind, OutlineSymbol[]>();
    for (const item of top) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);
    const nextOffset = offset + top.length < all.length ? offset + top.length : null;
    const lines = [`<symbols-outline file="${xml(parsed.virtual)}" symbols="${all.length}" offset="${offset}" parseErrors="${parsed.parseErrors}" capped="${nextOffset !== null}">`];
    for (const [kind, items] of groups) {
      lines.push(`  <group kind="${kind}">`);
      for (const item of items) lines.push(`    <symbol name="${xml(item.memberOf ? `${item.memberOf}.${item.name}` : item.name)}" line="${item.line}" col="${item.col}" sig="${xml(item.sig)}" />`);
      lines.push('  </group>');
    }
    if (nextOffset !== null) lines.push(`  <next offset="${nextOffset}" />`);
    lines.push('</symbols-outline>');
    return ok(lines.join('\n'), { action, file: parsed.virtual, symbols: all.length, offset, nextOffset, parseErrors: parsed.parseErrors, truncated: nextOffset !== null });
  }

  let query = input.query;
  if (action === 'usages' && !query && input.file && input.line) {
    const resolved = await resolveToolPath(roots, input.file);
    const parsed = await parseFile(resolved.real, resolved.virtual);
    if (!parsed) throw new Error(`Cannot parse ${resolved.virtual}`);
    query = parsed.identifiers.filter((item) => item.line === input.line).sort((a, b) => a.col - b.col)[0]?.name;
    if (!query) throw new Error(`No identifier found on ${resolved.virtual}:${input.line}`);
  }
  query = validateQuery(query);
  const files = await candidateFiles(roots, input.path, input.lang);
  const batch = await parseCandidates(files, query);

  const definitions = batch.parsed.flatMap((file) => file.symbols
    .filter((symbol) => symbol.name === query || action === 'search' && rank(query!, symbol.name) >= 0)
    .filter((symbol) => !input.kind || symbol.kind === input.kind)
    .map((symbol) => ({ file, symbol, rank: rank(query!, symbol.name) })))
    .sort((a, b) => a.rank - b.rank || a.symbol.kind.localeCompare(b.symbol.kind) || a.file.virtual.localeCompare(b.file.virtual) || a.symbol.line - b.symbol.line);

  if (action === 'search') {
    const shown = definitions.slice(offset, offset + maxResults);
    const nextOffset = offset + shown.length < definitions.length ? offset + shown.length : null;
    const lines = [
      `<symbols-search query="${xml(query)}" results="${definitions.length}" offset="${offset}" files="${batch.parsed.length}" skipped="${batch.skipped}" capped="${nextOffset !== null}">`,
      ...shown.map(({ file, symbol }) => `  <symbol file="${xml(file.virtual)}" line="${symbol.line}" col="${symbol.col}" name="${xml(symbol.name)}" kind="${symbol.kind}" sig="${xml(symbol.sig)}" />`),
      ...(nextOffset === null ? [] : [`  <next offset="${nextOffset}" />`]),
      '</symbols-search>'
    ];
    return ok(lines.join('\n'), { action, query, results: definitions.length, offset, nextOffset, files: batch.parsed.length, skipped: batch.skipped, truncated: nextOffset !== null || batch.skipped > 0 });
  }

  const exactDefs = definitions.filter((item) => item.symbol.name === query && item.symbol.kind !== 'import' && item.symbol.kind !== 'parameter');
  const defSet = new Set(exactDefs.map((item) => normalized(item.file.real)));
  const importReached = new Set<string>();
  for (const file of batch.parsed) {
    for (const imp of file.imports) {
      if (!(imp.bindings.includes(query) || imp.sources.includes(query))) continue;
      for (const target of resolveImport(imp.from, file.real)) if (defSet.has(target)) importReached.add(target);
    }
  }
  const refs: Array<{ file: ParsedFile; id: IdentifierInfo }> = [];
  const unattributed: Array<{ file: ParsedFile; id: IdentifierInfo; note: string }> = [];
  const defKinds = new Set(exactDefs.map((item) => item.symbol.kind));
  for (const file of batch.parsed) {
    const ownDecls = file.symbols.filter((symbol) => symbol.name === query && symbol.kind !== 'import' && symbol.kind !== 'parameter');
    const imports = file.imports.filter((imp) => imp.bindings.includes(query!) || imp.sources.includes(query!));
    const importResolves = imports.some((imp) => resolveImport(imp.from, file.real).some((target) => defSet.has(target)));
    const selfReached = importReached.has(normalized(file.real));
    for (const id of file.identifiers) {
      if (id.name !== query || id.isDecl) continue;
      const propertyTarget = defKinds.has('property') || defKinds.has('method');
      const attributed = (!id.propertyName || propertyTarget) && (importResolves || ownDecls.length > 0 && selfReached);
      if (attributed) refs.push({ file, id });
      else {
        const note = id.propertyName && !propertyTarget
          ? 'property-name match; target symbol is not a property/method'
          : ownDecls.length ? `declares its own '${query}'; match may be unrelated`
            : imports.length ? `imports '${query}' but the module did not resolve to a known definition`
              : `no resolved import/declaration for '${query}'; match may be unrelated`;
        unattributed.push({ file, id, note });
      }
    }
  }
  const combined = [
    ...refs.map((row) => ({ kind: 'ref' as const, row })),
    ...unattributed.map((row) => ({ kind: 'unattributed' as const, row }))
  ];
  const page = combined.slice(offset, offset + maxResults);
  const definitionPage = exactDefs.slice(definitionOffset, definitionOffset + maxResults);
  const nextDefinitionOffset = definitionOffset + definitionPage.length < exactDefs.length ? definitionOffset + definitionPage.length : null;
  const shownRefs = page.filter((item) => item.kind === 'ref').map((item) => item.row as { file: ParsedFile; id: IdentifierInfo });
  const shownUnattributed = page.filter((item) => item.kind === 'unattributed').map((item) => item.row as { file: ParsedFile; id: IdentifierInfo; note: string });
  const nextOffset = offset + page.length < combined.length ? offset + page.length : null;
  const lines = [
    `<symbols-usages query="${xml(query)}" defs="${exactDefs.length}" definitionOffset="${definitionOffset}" refs="${refs.length}" unattributed="${unattributed.length}" offset="${offset}" files="${batch.parsed.length}" skipped="${batch.skipped}" capped="${nextOffset !== null || nextDefinitionOffset !== null}">`,
    '  <definitions>',
    ...definitionPage.map(({ file, symbol }) => `    <def file="${xml(file.virtual)}" line="${symbol.line}" col="${symbol.col}" kind="${symbol.kind}" sig="${xml(symbol.sig)}" />`),
    ...(nextDefinitionOffset === null ? [] : [`    <next-definition offset="${nextDefinitionOffset}" />`]),
    '  </definitions>',
    '  <references>',
    ...shownRefs.map(({ file, id }) => `    <ref file="${xml(file.virtual)}" line="${id.line}" col="${id.col}" />`),
    '  </references>',
    '  <unattributed>',
    ...shownUnattributed.map(({ file, id, note }) => `    <match file="${xml(file.virtual)}" line="${id.line}" col="${id.col}" note="${xml(note)}" />`),
    '  </unattributed>',
    ...(nextOffset === null ? [] : [`  <next offset="${nextOffset}" />`]),
    '</symbols-usages>'
  ];
  return ok(lines.join('\n'), { action, query, defs: exactDefs.length, definitionOffset, nextDefinitionOffset, refs: refs.length, unattributed: unattributed.length, offset, nextOffset, files: batch.parsed.length, skipped: batch.skipped, truncated: nextOffset !== null || nextDefinitionOffset !== null || batch.skipped > 0 });
}
