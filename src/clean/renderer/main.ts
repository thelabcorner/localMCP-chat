import './style.css';
import { mount } from './app.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('control window root element is missing');
mount(root);
