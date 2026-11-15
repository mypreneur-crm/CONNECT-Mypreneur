const http = require('http');
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET || 'mypreneur_connect_local_secret_32chars_long_key_1234';

function sign(id) {
  const p = { v: 1, userId: id, csrf: "test", exp: Date.now() + 3600000 };
  const enc = Buffer.from(JSON.stringify(p)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(enc).digest("base64url");
  return enc + "." + sig;
}

function req(id, path) {
  return new Promise((resolve) => {
    const r = http.request({
      hostname: "127.0.0.1",
      port: 3000,
      path: path,
      headers: { "Cookie": "mc_session=" + sign(id), "x-csrf-token": "test" }
    }, res => {
      let b = "";
      res.on("data", c => b += c);
      res.on("end", () => {
        try {
          const data = JSON.parse(b);
          resolve({ status: res.statusCode, ok: res.statusCode === 200, keys: Object.keys(data) });
        } catch(e) {
          resolve({ status: res.statusCode, ok: false, raw: b });
        }
      });
    });
    r.end();
  });
}

(async () => {
  console.log("Super Admin windows/year:", await req(5, "/api/monthly-1on1/windows/year?year=2026"));
  console.log("Reviewer team-reports:", await req(22, "/api/monthly-1on1/team-reports"));
  console.log("Employee reports table:", await req(12, "/api/monthly-1on1/reports"));
})();
