const { exec } = require('child_process');

function run(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: 'cmd.exe'
    }, (error, stdout, stderr) => {
      resolve(JSON.stringify({
        command,
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: (stdout || '').slice(0, 6000),
        stderr: (stderr || (error ? error.message : '')).slice(0, 3000),
        timeout: !!(error && error.killed)
      }));
    });
  });
}

module.exports = { run };