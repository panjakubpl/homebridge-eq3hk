const { execSync } = require('child_process');
const path = require('path');

const scriptPath = path.join(__dirname, 'eq3.exp');

try {
  execSync(`chmod +x "${scriptPath}"`);
  console.log(`[homebridge-eq3hk] eq3.exp permissions set: ${scriptPath}`);
} catch (e) {
  console.warn(`[homebridge-eq3hk] Could not set eq3.exp permissions automatically.`);
  console.warn(`[homebridge-eq3hk] Run manually: sudo chmod +x ${scriptPath}`);
}

try {
  execSync('sudo systemctl restart mqtt_handler.service', { stdio: 'ignore' });
  console.log('[homebridge-eq3hk] mqtt_handler.service restarted.');
} catch (e) {
  // Service may not exist yet on fresh install — not an error
}
