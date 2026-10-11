const image = document.querySelector("#redirectImage");
let scheduled = false;
function scheduleRedirect() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    setTimeout(() => location.replace("https://wirewednesday.nissen.nexus/"), 2000);
  }));
}
if (image.complete) scheduleRedirect();
else {
  image.addEventListener("load", scheduleRedirect, { once: true });
  image.addEventListener("error", scheduleRedirect, { once: true });
}
