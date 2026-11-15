const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');

// Check that all 3 scripts are syntactically valid
const scripts = html.match(/<script[\s\S]*?<\/script>/gi);
console.log('Found scripts:', scripts.length);

scripts.forEach((s, idx) => {
  const code = s.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
  try {
    new Function(code);
    console.log(`Script ${idx}: SYNTAX VALID`);
  } catch(err) {
    console.error(`Script ${idx}: SYNTAX ERROR:`, err.message);
    process.exit(1);
  }
});

console.log('All scripts in public/index.html are 100% syntactically valid!');

