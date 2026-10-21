for (const name of ["pause", "hide", "stop"]) document.getElementById(name).addEventListener("click", () => window.computerPreview.action(name));
const frame = document.getElementById("frame"), cursor = document.getElementById("cursor");
let gliding = 0;
// A point in frame pixels → the shown image's box (object-fit: contain), in px of #frame.
function place(point, width, height, animate) {
  const box = frame.getBoundingClientRect(), scale = Math.min(box.width / width, box.height / height);
  const left = (box.width - width * scale) / 2 + point.x * scale, top = (box.height - height * scale) / 2 + point.y * scale;
  if (!animate) cursor.style.transition = "none";
  cursor.style.left = left + "px"; cursor.style.top = top + "px";
  if (!animate) { void cursor.offsetWidth; cursor.style.transition = ""; }
  cursor.hidden = false;
}
window.computerPreview.onState((value) => {
  document.getElementById("app").textContent = value.appName;
  document.getElementById("status").textContent = value.virtual
    ? "The agent's own display, with its own cursor. Your screen, mouse and keyboard are not used."
    : value.phase === "paused" ? value.status : value.mode === "observe" ? "Read only · no mouse or keyboard access" : "Keep this app in front. Your input pauses control.";
  document.getElementById("time").textContent = Math.ceil(value.remainingSeconds / 60) + " min";
  document.getElementById("pause").hidden = value.virtual || value.mode === "observe" || value.phase === "paused";
  if (!value.virtual) cursor.hidden = true;
  else if (value.cursor && value.frame && Date.now() > gliding) place(value.cursor, value.frame.width, value.frame.height, false);
});
window.computerPreview.onImage((value) => { document.getElementById("preview").src = value; });
// Each pointer act: the cursor glides from where it was to the target, like a person's.
window.computerPreview.onCursor((move) => {
  if (move.from) place(move.from, move.width, move.height, false);
  requestAnimationFrame(() => place(move.to, move.width, move.height, true));
  gliding = Date.now() + 400;
});
