'use strict';
if (require('node:fs').existsSync('.env') && !process.env.DB_HOST) {
  try { require('node:process').loadEnvFile('.env'); } catch (e) {}
}

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { ChatService } = require('../lib/chat/chat-service');
const assert = require('node:assert');

async function testChatSuite() {
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  console.log('Testing ChatService against live DB...');

  const chatService = new ChatService(db, null);

  // 1. Test presence update & get
  console.log('1. Testing Presence...');
  await chatService.updatePresence(1, 'ONLINE', 'Working on high-priority task');
  await chatService.updatePresence(22, 'AWAY', 'Taking quick lunch');
  const presenceAll = await chatService.getAllPresence();
  assert(presenceAll[1], 'Employee 1 presence exists');
  assert.strictEqual(presenceAll[1].status, 'ONLINE');
  assert(presenceAll[22], 'Employee 22 presence exists');
  assert.strictEqual(presenceAll[22].status, 'AWAY');
  console.log('  Presence test passed! Statuses:', { emp1: presenceAll[1].status, emp22: presenceAll[22].status });

  // 2. Test Direct Conversation
  console.log('2. Testing Direct Conversation get/create...');
  const convId1 = await chatService.getOrCreateDirectConversation(1, 22);
  const convId2 = await chatService.getOrCreateDirectConversation(22, 1);
  assert.strictEqual(convId1, convId2, 'Direct conversation should be symmetric');
  console.log('  Direct conversation created/retrieved:', convId1);

  // 3. Test Sending Messages
  console.log('3. Testing Message Sending...');
  const msg1 = await chatService.sendMessage({
    conversationId: convId1,
    senderEmpId: 1,
    senderUserId: 1,
    type: 'TEXT',
    content: 'Hello Swetha! Testing the real-time chat service.'
  });
  assert(msg1 && msg1.id, 'Message 1 created');
  assert.strictEqual(msg1.content, 'Hello Swetha! Testing the real-time chat service.');

  const msg2 = await chatService.sendMessage({
    conversationId: convId1,
    senderEmpId: 22,
    senderUserId: 22,
    type: 'TEXT',
    content: 'Hi! Received loud and clear.'
  });
  assert(msg2 && msg2.id, 'Message 2 created');
  console.log('  Messages sent successfully:', [msg1.id, msg2.id]);

  // 4. Test Message Retrieval
  console.log('4. Testing Message Retrieval...');
  const messages = await chatService.getMessages(convId1, 1, { limit: 10 });
  assert(messages.length >= 2, 'Should retrieve at least 2 messages');
  console.log(`  Retrieved ${messages.length} messages.`);

  // 5. Test Unread Summary
  console.log('5. Testing Unread Summary...');
  const unreadSummary = await chatService.getUnreadSummary(1);
  console.log('  Unread for Employee 1:', unreadSummary);

  // Mark read
  await chatService.markAsRead(convId1, 1);
  const unreadAfter = await chatService.getUnreadSummary(1);
  console.log('  Unread for Employee 1 after markAsRead:', unreadAfter.total_unread);

  // 6. Test Group Conversation
  console.log('6. Testing Group Conversation...');
  const groupConvId = await chatService.createGroupConversation(1, 'Product & Tech Warriors', [1, 22]);
  assert(groupConvId, 'Group conversation created');
  const groupMsg = await chatService.sendMessage({
    conversationId: groupConvId,
    senderEmpId: 1,
    type: 'TEXT',
    content: 'Welcome to Product & Tech Warriors!'
  });
  assert(groupMsg.id, 'Group message sent');
  console.log('  Group conversation created and message posted:', groupConvId);

  // 7. Test Conversations List
  console.log('7. Testing Conversations Listing...');
  const userConvs = await chatService.getConversations(1);
  assert(userConvs.length >= 2, 'Should list both direct and group conversations');
  console.log(`  Employee 1 has ${userConvs.length} conversations.`);

  // 8. Test WebRTC Signaling Flow
  console.log('8. Testing WebRTC Call Signaling...');
  const call = await chatService.initiateCall({
    callerEmpId: 1,
    receiverEmpId: 22,
    conversationId: convId1,
    callType: 'VIDEO',
    sdpOffer: '{"type":"offer","sdp":"mock-sdp-offer-string"}'
  });
  assert(call.callId, 'Call session created');
  assert.strictEqual(call.status, 'RINGING');

  // Callee checks incoming call
  const incoming = await chatService.checkIncomingCall(22);
  assert(incoming, 'Callee should detect incoming call');
  assert.strictEqual(incoming.callId, call.callId);
  console.log('  Incoming call detected by Employee 22:', incoming.callerName);

  // Callee responds with accept & answer
  const answer = await chatService.respondCall({
    callId: call.callId,
    responderEmpId: 22,
    action: 'ACCEPT',
    sdpAnswer: '{"type":"answer","sdp":"mock-sdp-answer-string"}'
  });
  assert.strictEqual(answer.status, 'ACCEPTED');

  // Caller exchange ICE
  const iceRes = await chatService.exchangeIce({
    callId: call.callId,
    employeeId: 1,
    candidate: { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
  });
  assert.strictEqual(iceRes.status, 'ACCEPTED');

  // End call
  await chatService.respondCall({ callId: call.callId, responderEmpId: 1, action: 'END' });
  const endedCall = await chatService.getCall(call.callId);
  assert.strictEqual(endedCall.status, 'ENDED');
  console.log('  WebRTC Call signaling complete and ended cleanly!');

  // Cleanup test presence so database presence remains accurate
  await db.run('UPDATE connect_employee_presence SET status = "OFFLINE", last_heartbeat = 0 WHERE employee_id IN (1, 22)');

  console.log('\n=== ALL CHAT BACKEND TESTS PASSED SUCCESSFULLY! ===\n');
  await db.close();
}

testChatSuite().catch(err => {
  console.error('Chat test failed:', err);
  process.exit(1);
});

