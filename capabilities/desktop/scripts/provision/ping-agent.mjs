// 用 native-messaging 的 `ping` 证明 stream-desktop.exe 在这台机器上真能跑起来。
// 为什么是 ping 而不是 token：ping 那条分支只回一个编译进去的版本号，**不碰文件系统**
// （`nativemsg.rs` 的 handle）。token 会去读 ~/.stream/datadir 指到的那份，而这台机器上
// 已经有一份上一轮留下的指针——用 token 验，等于把「二进制能不能跑」和「指针指着谁」
// 两件事搅在一起。而且配对本身属于 Task 3，这里只证明「东西在、能跑」。
import { spawn } from 'node:child_process';

// 默认值必须是**后端真正会拉起的那一份**（`resolveAgentBinary()` 的第一级，npm 装出来的）。
// `C:\stream-pair\bin\` 那个路径没有任何一级解析会读——拿它当默认，等于让人去 ping 一份没人
// 用的二进制，而它照样会回 `ok:true`。见 `provision-win-test.md` §3。
const bin =
  process.argv[2] ||
  'C:\\stream-pair\\plugin\\node_modules\\@streamapp\\desktop-win32-x64\\bin\\stream-desktop.exe';

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length); // Chrome 用主机字节序；x64 上就是 LE
  return Buffer.concat([len, body]);
}

const child = spawn(bin, ['--native-messaging'], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = Buffer.alloc(0);
let err = '';
child.stdout.on('data', (d) => {
  out = Buffer.concat([out, d]);
  if (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) {
    console.log('REPLY=' + out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8'));
    child.kill();
  }
});
child.stderr.on('data', (d) => (err += d));
child.on('error', (e) => { console.log('SPAWN_ERROR=' + e.message); process.exit(1); });
child.on('close', (code) => {
  if (err.trim()) console.log('STDERR=' + err.trim());
  if (out.length === 0) { console.log('NO_REPLY exit=' + code); process.exit(1); }
});
setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1); }, 10000);

child.stdin.write(encodeFrame({ op: 'ping', id: 1 }));
