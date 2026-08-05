const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Client: SSHClient } = require('ssh2');

// 1. Parse .env manually
const dotenv = {};
try {
  const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      let val = match[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      dotenv[key] = val;
    }
  });
} catch (e) {
  console.error('Failed to read .env file:', e.message);
  process.exit(1);
}

// 2. Run local unit tests
try {
  console.log('--- Running Local Unit Tests ---');
  execSync('npm test', { stdio: 'inherit' });
  console.log('Unit tests passed successfully!\n');
} catch (error) {
  console.error('Unit tests failed. Deployment aborted.');
  process.exit(1);
}

// 3. Generate .htaccess with PassengerEnvVar for all env vars
const skipKeys = new Set(['SSH_HOST', 'SSH_PORT', 'SSH_USER', 'SSH_PASSWORD']);
const envVarLines = Object.entries(dotenv)
  .filter(([k]) => !skipKeys.has(k))
  .map(([k, v]) => `PassengerEnvVar ${k} "${v}"`)
  .join('\n');
const htaccessContent = `PassengerAppRoot /home/u847929344/domains/mypreneur.co.in/public_html/connect
PassengerAppType node
PassengerStartupFile server.js
PassengerNodejs /opt/alt/alt-nodejs22/root/usr/bin/node
${envVarLines}
`;
fs.writeFileSync(path.join(__dirname, '.htaccess'), htaccessContent, 'utf8');
console.log('Generated .htaccess with PassengerEnvVar directives.\n');

// 4. Create compressed build archive
const archiveName = 'connect-deploy.tar.gz';
const localArchive = path.join(__dirname, archiveName);
try {
  console.log('--- Creating Project Archive ---');
  if (fs.existsSync(localArchive)) {
    fs.unlinkSync(localArchive);
  }
  // Exclude node_modules, config files, local database files, logs, and inspect scripts
  execSync('tar -czf connect-deploy.tar.gz --exclude=node_modules --exclude=.git --exclude=.env --exclude=data --exclude=*.log --exclude=.agents --exclude=connect-deploy.tar.gz --exclude=inspect_vps.js --exclude=deploy.js .', { cwd: __dirname, stdio: 'inherit' });
  console.log('Archive created: connect-deploy.tar.gz\n');
} catch (error) {
  console.error('Failed to create project archive:', error.message);
  process.exit(1);
}

// 4. Upload and Deploy over SSH
const config = {
  host: dotenv.SSH_HOST || '194.163.35.120',
  port: parseInt(dotenv.SSH_PORT || '65002', 10),
  username: dotenv.SSH_USER || 'u847929344',
  password: dotenv.SSH_PASSWORD || 'Jinjaa@123'
};
const remoteDir = '/home/u847929344/domains/mypreneur.co.in/public_html/connect';
const remoteArchive = `${remoteDir}/${archiveName}`;

console.log('--- Connecting to Hostinger ---');
const conn = new SSHClient();
conn.on('ready', () => {
  console.log('SSH connection established successfully.');
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP initialization failed:', err.message);
      conn.end();
      process.exit(1);
    }
    
    console.log(`Uploading ${archiveName} to ${remoteDir}...`);
    sftp.fastPut(localArchive, remoteArchive, {}, (uploadErr) => {
      if (uploadErr) {
        console.error('Upload failed:', uploadErr.message);
        conn.end();
        process.exit(1);
      }
      console.log('Upload complete.\n');
      
      console.log('--- Remote Server Extract & Install ---');
      const cmd = `bash -lc "cd ${remoteDir} && tar -xzf ${archiveName} && rm -f ${archiveName} && /opt/alt/alt-nodejs22/root/usr/bin/npm install --omit=dev && mkdir -p tmp && touch tmp/restart.txt"`;
      console.log('Running remote build commands...');
      
      conn.exec(cmd, (execErr, stream) => {
        if (execErr) {
          console.error('Remote execution failed to start:', execErr.message);
          conn.end();
          process.exit(1);
        }
        
        stream.on('close', (code, signal) => {
          console.log(`\nRemote build execution finished with code ${code}`);
          conn.end();
          
          // Cleanup local archive
          try {
            if (fs.existsSync(localArchive)) {
              fs.unlinkSync(localArchive);
              console.log('Cleaned up local archive file.');
            }
          } catch(e) {
            console.warn('Failed to delete local archive:', e.message);
          }
          
          if (code === 0) {
            console.log('\n=========================================');
            console.log('DEPLOYMENT TO CONNECT PORTAL SUCCESSFUL!');
            console.log('=========================================');
            process.exit(0);
          } else {
            console.error('\nDeployment finished with non-zero exit code.');
            process.exit(code);
          }
        }).on('data', (data) => {
          process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
          process.stderr.write(data.toString());
        });
      });
    });
  });
}).on('error', (err) => {
  console.error('SSH Connection Error:', err.message);
  process.exit(1);
}).connect(config);
