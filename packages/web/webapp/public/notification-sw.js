self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const threadId = typeof data.threadId === "string" ? data.threadId : undefined;
  const url = typeof data.url === "string" ? data.url : "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows[0];
    if (target) {
      await target.focus();
      if (threadId) target.postMessage({ type: "mono-agent:select-thread", threadId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
