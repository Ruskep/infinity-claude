const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const src = path.join(buildDir, 'icon.png');
const b64 = fs.readFileSync(src).toString('base64');

const sizes = [256, 128, 64, 48, 40, 32, 24, 20, 16];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const js = `
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const sizes = ${JSON.stringify(sizes)};
        const out = {};
        for (const s of sizes) {
          const c = document.createElement('canvas');
          c.width = s; c.height = s;
          const ctx = c.getContext('2d');
          ctx.clearRect(0, 0, s, s);
          ctx.drawImage(img, 0, 0, s, s);
          out[s] = c.toDataURL('image/png');
        }
        resolve(out);
      };
      img.src = 'data:image/png;base64,${b64}';
    })`;
  const result = await win.webContents.executeJavaScript(js, true);
  const tmp = path.join(buildDir, '_auto-icon');
  fs.mkdirSync(tmp, { recursive: true });
  for (const s of Object.keys(result)) {
    const b64 = result[s].split(',')[1];
    fs.writeFileSync(path.join(tmp, `icon-${s}.png`), Buffer.from(b64, 'base64'));
  }
  console.log('rendered ' + Object.keys(result).length + ' sizes from icon.png');
  app.exit(0);
});