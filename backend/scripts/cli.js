// Terminal chat with the agent. Shows the tool calls so you can watch it "think".
import 'dotenv/config';
import readline from 'node:readline/promises';
import { chat, MODEL } from '../src/agent.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const history = [];
console.log(`Bosch product assistant (model ${MODEL}). Type "exit" to quit, "reset" to start over.\n`);
while (true) {
  const q = (await rl.question('you > ')).trim();
  if (!q) continue;
  if (q === 'exit') break;
  if (q === 'reset') { history.length = 0; console.log('(conversation reset)\n'); continue; }
  history.push({ role: 'user', content: q });
  try {
    const { reply, trace } = await chat(history);
    for (const t of trace) console.log(`  \x1b[90m[tool] ${t.tool}(${JSON.stringify(t.args)}) -> ${t.result_preview}\x1b[0m`);
    console.log(`\nagent > ${reply}\n`);
    history.push({ role: 'assistant', content: reply });
  } catch (e) {
    console.error('error:', e.message);
    history.pop();
  }
}
rl.close();
