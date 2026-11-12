const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Load environment variables
const envFile = path.join(__dirname, '../.env');
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, 'utf8');
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  });
}

let Client;
try {
  Client = require('ssh2').Client;
} catch {
  Client = require(path.resolve(__dirname, '../../FPBuddy-Mypreneur PROD/backend/node_modules/ssh2')).Client;
}

const rootDir = path.resolve(__dirname, '..');
const deployDir = '/home/u847929344/domains/mypreneur.co.in/public_html/connect';
const archiveName = 'connect_update.tar.gz';
const localArchive = path.join(rootDir, archiveName);

async function deploy() {
  console.log('=== Packaging CONNECT-Mypreneur PROD into tar.gz ===');
  if (fs.existsSync(localArchive)) fs.unlinkSync(localArchive);

  execSync(
    `tar -czf "${archiveName}" --exclude=.env --exclude=node_modules --exclude=.git --exclude=${archiveName} --exclude=data/uploads server.js lib public database scripts`,
    { cwd: rootDir, stdio: 'inherit' }
  );

  console.log('Archive created. Connecting to Hostinger via SFTP...');
  const conn = new Client();

  conn.on('ready', () => {
    console.log('[SSH] Connection established.');
    conn.sftp((err, sftp) => {
      if (err) {
        console.error('SFTP Error:', err);
        conn.end();
        process.exit(1);
      }

      const remoteArchive = `${deployDir}/${archiveName}`;
      console.log(`Uploading ${archiveName} via SFTP to ${remoteArchive}...`);

      sftp.fastPut(localArchive, remoteArchive, (uErr) => {
        if (uErr) {
          console.error('Upload Error:', uErr);
          conn.end();
          process.exit(1);
        }

        console.log('Upload successful! Extracting archive, applying DB migrations, and restarting Passenger...');
        const extractCmd = `bash -lc '
          cd ${deployDir}
          tar -xzf ${archiveName}
          rm -f ${archiveName}
          mkdir -p tmp
          /opt/alt/alt-nodejs22/root/usr/bin/node --env-file=.env scripts/migrate-task-tables.js || true
          touch tmp/restart.txt
          pkill -9 -f "connect" || true
          echo "Passenger restart triggered for Connect."
        '`;

        conn.exec(extractCmd, (xErr, stream) => {
          if (xErr) throw xErr;
          stream.on('data', d => process.stdout.write(d.toString()));
          stream.stderr.on('data', d => process.stderr.write(d.toString()));
          stream.on('close', (code) => {
            console.log(`Deployment of Connect complete (exit code ${code})`);
            if (fs.existsSync(localArchive)) fs.unlinkSync(localArchive);
            conn.end();
          });
        });
      });
    });
  }).on('error', err => {
    console.error('SSH Connection Error:', err);
    process.exit(1);
  }).connect({
    host: process.env.SSH_HOST,
    port: parseInt(process.env.SSH_PORT || '65002', 10),
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD
  });
}

deploy().catch(console.error);
