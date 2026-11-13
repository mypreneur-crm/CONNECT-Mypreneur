'use strict';

const path = require('node:path');

function registerChatRoutes({ db, fileStore, chatService, requireAuth, sendJson, sendError, readJson, cleanText, securityHeaders }) {
  return async function handleChatApi(req, res, url) {
    const { method } = req;
    const pathname = url.pathname;

    /* ================= PRESENCE ================= */

    if (method === 'POST' && pathname === '/api/chat/presence/heartbeat') {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const body = await readJson(req).catch(() => ({}));
      const empId = auth.user.employeeId || auth.user.id;
      const status = body.status === 'AWAY' ? 'AWAY' : (body.status === 'OFFLINE' ? 'OFFLINE' : 'ONLINE');
      const customStatus = cleanText(body.custom_status || '', 120);

      const presence = await chatService.updatePresence(empId, status, customStatus);
      sendJson(res, 200, { ok: true, presence });
      return true;
    }

    if (method === 'GET' && pathname === '/api/chat/presence/all') {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const presence = await chatService.getAllPresence();
      sendJson(res, 200, { ok: true, presence });
      return true;
    }

    /* ================= UNREAD SUMMARY & OFFLINE CATCHUP ================= */

    if (method === 'GET' && pathname === '/api/chat/unread-summary') {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const empId = auth.user.employeeId || auth.user.id;
      const summary = await chatService.getUnreadSummary(empId);
      sendJson(res, 200, { ok: true, ...summary });
      return true;
    }

    /* ================= CONVERSATIONS ================= */

    if (method === 'GET' && pathname === '/api/chat/conversations') {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const empId = auth.user.employeeId || auth.user.id;
      const conversations = await chatService.getConversations(empId);
      sendJson(res, 200, { ok: true, conversations });
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/conversations/direct') {
      const auth = await requireAuth(req, res, { csrf: true });
      if (!auth) return true;
      const body = await readJson(req);
      const targetEmpId = Number(body.target_employee_id);
      const myEmpId = auth.user.employeeId || auth.user.id;

      if (!targetEmpId) {
        sendError(res, 400, 'Target employee ID is required', 'VALIDATION');
        return true;
      }

      const convId = await chatService.getOrCreateDirectConversation(myEmpId, targetEmpId);
      sendJson(res, 200, { ok: true, conversation_id: convId });
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/conversations/group') {
      const auth = await requireAuth(req, res, { csrf: true });
      if (!auth) return true;
      const body = await readJson(req);
      const title = cleanText(body.title, 100);
      const memberIds = Array.isArray(body.member_employee_ids) ? body.member_employee_ids : [];
      const myEmpId = auth.user.employeeId || auth.user.id;

      if (!title) {
        sendError(res, 400, 'Group title is required', 'VALIDATION');
        return true;
      }

      const convId = await chatService.createGroupConversation(myEmpId, title, memberIds);
      sendJson(res, 201, { ok: true, conversation_id: convId });
      return true;
    }

    /* ================= MESSAGES ================= */

    // GET /api/chat/conversations/:id/messages
    const messagesGetMatch = pathname.match(/^\/api\/chat\/conversations\/([a-zA-Z0-9_-]+)\/messages$/);
    if (method === 'GET' && messagesGetMatch) {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const convId = messagesGetMatch[1];
      const myEmpId = auth.user.employeeId || auth.user.id;
      const after = url.searchParams.get('since') || null;
      const limit = Number(url.searchParams.get('limit')) || 50;

      try {
        const messages = await chatService.getMessages(convId, myEmpId, { after, limit });
        sendJson(res, 200, { ok: true, messages });
      } catch (err) {
        sendError(res, 403, err.message, 'FORBIDDEN');
      }
      return true;
    }

    // POST /api/chat/conversations/:id/messages
    const messagesPostMatch = pathname.match(/^\/api\/chat\/conversations\/([a-zA-Z0-9_-]+)\/messages$/);
    if (method === 'POST' && messagesPostMatch) {
      const auth = await requireAuth(req, res, { csrf: true });
      if (!auth) return true;
      const convId = messagesPostMatch[1];
      const myEmpId = auth.user.employeeId || auth.user.id;
      const body = await readJson(req);

      let fileObj = null;
      if (body.file && body.file.data) {
        const rawName = String(body.file.name || 'document').trim();
        const commaIndex = body.file.data.indexOf(',');
        if (body.file.data.startsWith('data:') && commaIndex !== -1) {
          const base64Str = body.file.data.slice(commaIndex + 1).replace(/[\s]/g, '');
          const buffer = Buffer.from(base64Str, 'base64');
          if (buffer.length && buffer.length <= 25 * 1024 * 1024) {
            fileObj = {
              name: rawName,
              type: body.file.type || 'application/octet-stream',
              buffer
            };
          }
        }
      }

      try {
        const message = await chatService.sendMessage({
          conversationId: convId,
          senderEmpId: myEmpId,
          senderUserId: auth.user.id,
          type: body.type || (fileObj ? 'FILE' : 'TEXT'),
          content: cleanText(body.content, 4000),
          fileObj
        });
        sendJson(res, 201, { ok: true, message });
      } catch (err) {
        sendError(res, 400, err.message, 'CHAT_ERROR');
      }
      return true;
    }

    // POST /api/chat/conversations/:id/read
    const readMatch = pathname.match(/^\/api\/chat\/conversations\/([a-zA-Z0-9_-]+)\/read$/);
    if (method === 'POST' && readMatch) {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const convId = readMatch[1];
      const myEmpId = auth.user.employeeId || auth.user.id;
      await chatService.markAsRead(convId, myEmpId);
      sendJson(res, 200, { ok: true });
      return true;
    }

    /* ================= FILE DOWNLOAD / STREAMING ================= */

    if (method === 'GET' && pathname.startsWith('/api/chat/files/')) {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const storageKey = decodeURIComponent(pathname.replace('/api/chat/files/', ''));

      try {
        const stat = await fileStore.stat(storageKey);
        const fileName = path.basename(storageKey);
        const ext = path.extname(fileName).toLowerCase();
        let mime = 'application/octet-stream';
        if (['.jpg', '.jpeg'].includes(ext)) mime = 'image/jpeg';
        else if (ext === '.png') mime = 'image/png';
        else if (ext === '.gif') mime = 'image/gif';
        else if (ext === '.webp') mime = 'image/webp';
        else if (ext === '.pdf') mime = 'application/pdf';

        securityHeaders(res, false);
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': stat.size,
          'Content-Disposition': `${mime.startsWith('image/') || ext === '.pdf' ? 'inline' : 'attachment'}; filename="${fileName}"`,
          'Cache-Control': 'private, max-age=86400'
        });

        const stream = fileStore.createReadStream(storageKey);
        stream.on('error', err => {
          if (!res.headersSent) sendError(res, 500, 'Error streaming file', 'STREAM_ERROR');
          else res.destroy(err);
        });
        stream.pipe(res);
      } catch (err) {
        sendError(res, 404, 'File not found.', 'NOT_FOUND');
      }
      return true;
    }

    /* ================= WEBRTC CALLING ENDPOINTS ================= */

    // Initiate Call
    if (method === 'POST' && pathname === '/api/chat/call/initiate') {
      const auth = await requireAuth(req, res, { csrf: true });
      if (!auth) return true;
      const body = await readJson(req);
      const myEmpId = auth.user.employeeId || auth.user.id;
      const receiverEmpId = Number(body.receiver_employee_id);
      const conversationId = body.conversation_id || null;
      const callType = body.call_type === 'VIDEO' ? 'VIDEO' : 'AUDIO';
      const sdpOffer = body.sdp_offer;

      try {
        const result = await chatService.initiateCall({
          callerEmpId: myEmpId,
          receiverEmpId,
          conversationId,
          callType,
          sdpOffer
        });
        sendJson(res, 201, { ok: true, ...result });
      } catch (err) {
        sendError(res, 400, err.message, 'CALL_ERROR');
      }
      return true;
    }

    // Callee polling for incoming calls
    if (method === 'GET' && pathname === '/api/chat/call/check-incoming') {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const myEmpId = auth.user.employeeId || auth.user.id;
      const incoming = await chatService.checkIncomingCall(myEmpId);
      sendJson(res, 200, { ok: true, incoming });
      return true;
    }

    // Respond to call (ACCEPT / DECLINE / BUSY / END)
    if (method === 'POST' && pathname === '/api/chat/call/respond') {
      const auth = await requireAuth(req, res, { csrf: true });
      if (!auth) return true;
      const body = await readJson(req);
      const myEmpId = auth.user.employeeId || auth.user.id;
      const callId = body.call_id;
      const action = body.action; // ACCEPT, DECLINE, BUSY, END
      const sdpAnswer = body.sdp_answer || null;

      try {
        const result = await chatService.respondCall({
          callId,
          responderEmpId: myEmpId,
          action,
          sdpAnswer
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendError(res, 400, err.message, 'CALL_ERROR');
      }
      return true;
    }

    // ICE Candidate exchange
    if (method === 'POST' && pathname === '/api/chat/call/ice') {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const body = await readJson(req);
      const myEmpId = auth.user.employeeId || auth.user.id;
      const callId = body.call_id;
      const candidate = body.candidate || null;

      try {
        const result = await chatService.exchangeIce({
          callId,
          employeeId: myEmpId,
          candidate
        });
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendError(res, 400, err.message, 'CALL_ERROR');
      }
      return true;
    }

    // Poll call state
    const callPollMatch = pathname.match(/^\/api\/chat\/call\/([a-zA-Z0-9_-]+)\/poll$/);
    if (method === 'GET' && callPollMatch) {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const callId = callPollMatch[1];
      const myEmpId = auth.user.employeeId || auth.user.id;

      try {
        const result = await chatService.exchangeIce({
          callId,
          employeeId: myEmpId,
          candidate: null
        });
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendError(res, 400, err.message, 'CALL_ERROR');
      }
      return true;
    }

    // End call
    const callEndMatch = pathname.match(/^\/api\/chat\/call\/([a-zA-Z0-9_-]+)\/end$/);
    if (method === 'POST' && callEndMatch) {
      const auth = await requireAuth(req, res);
      if (!auth) return true;
      const callId = callEndMatch[1];
      const myEmpId = auth.user.employeeId || auth.user.id;
      await chatService.respondCall({ callId, responderEmpId: myEmpId, action: 'END' });
      sendJson(res, 200, { ok: true });
      return true;
    }

    return false; // not handled by chat routes
  };
}

module.exports = { registerChatRoutes };

