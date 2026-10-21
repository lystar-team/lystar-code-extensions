import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const implementationRoot = new URL('../../extensions/lystar-jev-anti-slop/', import.meta.url).href.slice(0, -1);
const home = mkdtempSync(join(homedir(), '.slop-test-home-'));
const rulesDirectory = join(home, '.agents/skills/anti-ai-slop');
mkdirSync(rulesDirectory, { recursive: true });
copyFileSync(new URL('../../rules/anti-ai-slop.rules.json', import.meta.url), join(rulesDirectory, 'rules.json'));
process.env.HOME = home;
if (process.platform === 'win32') process.env.USERPROFILE = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
