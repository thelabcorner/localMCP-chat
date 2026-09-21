import type { CallToolResult } from '@modelcontextprotocol/client';
import { pluginManager } from '../../../main/plugins/manager.js';
import type { NativeCallAuthority } from '../../../main/plugins/native.js';
import { fail } from './common.js';

export interface IntegrationInput {
  action?: 'list' | 'inspect' | 'call';
  plugin?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  query?: string;
  offset?: number;
  limit?: number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Expected an integer from ${min} to ${max}.`);
  return Number(value);
}

function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export async function integrationTool(input: IntegrationInput, authority: NativeCallAuthority): Promise<CallToolResult> {
  try {
    const action = input.action ?? 'list';
    if (action === 'list') {
      const query = text(input.query)?.toLowerCase();
      const offset = int(input.offset, 0, 0, 100_000);
      const limit = int(input.limit, 20, 1, 100);
      const rows = pluginManager.integrationList().filter(plugin => !query ||
        plugin.id.toLowerCase().includes(query) ||
        plugin.name.toLowerCase().includes(query) ||
        plugin.catalogId?.toLowerCase().includes(query) ||
        plugin.tools.some(tool => tool.name.toLowerCase().includes(query) || tool.description?.toLowerCase().includes(query)));
      const page = rows.slice(offset, offset + limit);
      return ok({
        integrations: page,
        total: rows.length,
        offset,
        ...(offset + page.length < rows.length ? { nextOffset: offset + page.length } : {}),
      });
    }

    const toolName = text(input.tool);
    if (!toolName) return fail(`${action} requires tool.`);
    if (action === 'inspect') {
      const selected = pluginManager.integrationTool(toolName, text(input.plugin));
      return ok(selected);
    }
    if (action === 'call') {
      // Validate optional ownership before calling so an ambiguous same-name declaration can never
      // be silently routed to the wrong integration.
      if (text(input.plugin)) pluginManager.integrationTool(toolName, text(input.plugin));
      const args = input.arguments === undefined ? {} : input.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('arguments must be an object.');
      return await pluginManager.call(toolName, args, undefined, authority);
    }
    return fail(`Unsupported integration action: ${String(action)}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
