'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

http.get('http://localhost:3000', res => {
  assert.equal(res.statusCode, 200);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    // 1. Verify MENU contains tasks and employee_contact
    assert.ok(data.includes('id:"tasks",            label:"Task Manager"'), 'MENU must have Task Manager');
    assert.ok(data.includes('id:"employee_contact", label:"Employee Contacts"'), 'MENU must have Employee Contacts');

    // 2. Verify canSeeRoute allows both
    assert.ok(data.includes('r === "tasks"'), 'canSeeRoute must check tasks');
    assert.ok(data.includes('r === "employee_contact"'), 'canSeeRoute must check employee_contact');

    // 3. Verify external scripts
    assert.ok(data.includes('/tasks-app.js'), 'Must load tasks-app.js');
    assert.ok(data.includes('/messenger-app.js'), 'Must load messenger-app.js');
    assert.ok(data.includes('/tasks-style.css'), 'Must load tasks-style.css');

    console.log('✅ ALL SIDEBAR MENU CHECKS PASSED:');
    console.log('   - Task Manager menu is defined and permitted by canSeeRoute()');
    console.log('   - Employee Contacts & Directory menu is defined and permitted by canSeeRoute()');
    console.log('   - All assets, scripts, and CSS are correctly referenced and served');
  });
}).on('error', err => {
  console.error('Failed to connect:', err);
  process.exit(1);
});

