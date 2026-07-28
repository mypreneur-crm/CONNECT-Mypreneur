'use strict';
const fs = require('fs');

const dump = fs.readFileSync('c:/Users/kaviy/OneDrive/Documents/Myprenuer/mypreneur connect/hostinger_dump.sql', 'utf8');

const getTableInsert = (tableName) => {
  const regex = new RegExp(`INSERT INTO \`${tableName}\`[^;]+;`, 'i');
  const match = dump.match(regex);
  return match ? match[0] : 'No insert found for ' + tableName;
};

console.log('=== USERS IN DUMP ===');
console.log(getTableInsert('users'));

console.log('\n=== EMPLOYEES IN DUMP ===');
console.log(getTableInsert('employees'));

console.log('\n=== ROLES IN DUMP ===');
console.log(getTableInsert('roles'));

console.log('\n=== USER_ROLES IN DUMP ===');
console.log(getTableInsert('user_roles'));

console.log('\n=== TEAMS IN DUMP ===');
console.log(getTableInsert('teams'));
