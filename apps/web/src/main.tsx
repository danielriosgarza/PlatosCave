import { mount } from './app';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
mount(root);
