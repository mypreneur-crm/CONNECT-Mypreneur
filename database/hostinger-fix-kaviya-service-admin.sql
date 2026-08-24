-- Hostinger MySQL Database Fix Script for Service Admin Kaviya (Employee ID 13)
-- Run this SQL in phpMyAdmin or MySQL console on your Hostinger database server.

-- 1. Ensure SERVICE ADMIN role (role_id 13) exists in roles table
INSERT INTO roles (role_id, role_name, description)
VALUES (13, 'SERVICE ADMIN', 'Service Administrator with Connect management access')
ON DUPLICATE KEY UPDATE
  role_name = 'SERVICE ADMIN',
  description = 'Service Administrator with Connect management access';

-- 2. Remove legacy service.admin / service_admin entries if present
DELETE FROM user_roles WHERE role_id IN (SELECT role_id FROM roles WHERE LOWER(role_name) IN ('service.admin', 'service_admin'));
DELETE FROM roles WHERE LOWER(role_name) IN ('service.admin', 'service_admin');

-- 3. Assign SERVICE ADMIN (role_id 13) to Kaviya's user account (employee_id 13)
DELETE FROM user_roles WHERE user_id IN (SELECT user_id FROM users WHERE employee_id = 13);
INSERT INTO user_roles (user_id, role_id)
SELECT user_id, 13 FROM users WHERE employee_id = 13;

-- 4. Verify the updated assignment
SELECT u.user_id, u.username, u.employee_id, r.role_id, r.role_name, r.description
FROM users u
JOIN user_roles ur ON ur.user_id = u.user_id
JOIN roles r ON r.role_id = ur.role_id
WHERE u.employee_id = 13;
