const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const replyEl = document.getElementById("reply");
const eventsEl = document.getElementById("events");

function appendEvent(obj) {
  const line = JSON.stringify(obj, null, 2);
  eventsEl.textContent = `${line}\n\n${eventsEl.textContent}`.slice(0, 20000);
}

async function sendText() {
  const text = chatInput.value.trim();
  if (!text) return;

  replyEl.textContent = "…";

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  const data = await response.json();
  replyEl.textContent = JSON.stringify(data, null, 2);
}

sendBtn.addEventListener("click", sendText);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendText();
});

for (const chip of document.querySelectorAll("[data-fill]")) {
  chip.addEventListener("click", () => {
    chatInput.value = chip.getAttribute("data-fill");
    chatInput.focus();
  });
}

const es = new EventSource("/api/events");
es.addEventListener("message", (evt) => {
  try {
    appendEvent(JSON.parse(evt.data));
  } catch {
    appendEvent({ type: "event", raw: evt.data });
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
