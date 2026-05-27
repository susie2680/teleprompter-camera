const preview = document.querySelector("#preview");
const cameraButton = document.querySelector("#cameraButton");
const recordButton = document.querySelector("#recordButton");
const pauseButton = document.querySelector("#pauseButton");
const scriptInput = document.querySelector("#scriptInput");
const scriptText = document.querySelector("#scriptText");
const scriptTrack = document.querySelector("#scriptTrack");
const teleprompter = document.querySelector("#teleprompter");
const speedInput = document.querySelector("#speedInput");
const fontInput = document.querySelector("#fontInput");
const opacityInput = document.querySelector("#opacityInput");
const positionInput = document.querySelector("#positionInput");
const mirrorInput = document.querySelector("#mirrorInput");
const autoScrollInput = document.querySelector("#autoScrollInput");
const statusText = document.querySelector("#statusText");
const timer = document.querySelector("#timer");
const countdown = document.querySelector("#countdown");
const downloadLink = document.querySelector("#downloadLink");

let stream = null;
let recorder = null;
let recordedChunks = [];
let recordingStartedAt = 0;
let timerId = null;
let scrollFrame = null;
let lastScrollFrameAt = 0;
let isScrolling = false;
let wakeLock = null;

const defaultScript = [
  "大家好，今天我想分享一个很实用的方法。",
  "你可以把每句话拆短一点，录制时眼睛移动会小很多。",
  "看屏幕顶部的文案，同时把注意力放在镜头附近。",
  "如果速度不合适，可以暂停后调整，再继续录。"
].join("\n");

scriptInput.value = defaultScript;
syncScript();
applyVisualSettings();

cameraButton.addEventListener("click", toggleCamera);
recordButton.addEventListener("click", toggleRecording);
pauseButton.addEventListener("click", toggleScroll);
scriptInput.addEventListener("input", syncScript);
speedInput.addEventListener("input", () => {});
fontInput.addEventListener("input", applyVisualSettings);
opacityInput.addEventListener("input", applyVisualSettings);
positionInput.addEventListener("change", applyVisualSettings);
mirrorInput.addEventListener("change", applyVisualSettings);
autoScrollInput.addEventListener("change", () => {
  if (!autoScrollInput.checked) stopScroll();
});

window.addEventListener("beforeunload", () => {
  stopCamera();
  releaseWakeLock();
});

function syncScript() {
  const text = scriptInput.value.trim();
  scriptText.textContent = text || "把文案粘贴到下方，点击“打开相机”，再开始录制。";
  resetScroll();
}

function applyVisualSettings() {
  scriptText.style.fontSize = `${fontInput.value}px`;
  document.documentElement.style.setProperty("--prompt-bg", `rgba(7, 9, 13, ${Number(opacityInput.value) / 100})`);
  teleprompter.classList.remove("position-top", "position-middle", "position-bottom");
  teleprompter.classList.add(`position-${positionInput.value}`);
  preview.classList.toggle("mirrored", mirrorInput.checked);
}

async function toggleCamera() {
  if (stream) {
    stopCamera();
    return;
  }

  try {
    statusText.textContent = "正在请求相机权限";
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1080 },
        height: { ideal: 1920 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    preview.srcObject = stream;
    await preview.play();
    cameraButton.textContent = "关闭相机";
    recordButton.disabled = false;
    statusText.textContent = "相机已打开";
    await requestWakeLock();
  } catch (error) {
    statusText.textContent = "相机打开失败";
    alert(getCameraErrorMessage(error));
  }
}

function stopCamera() {
  stopRecording();
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  preview.srcObject = null;
  cameraButton.textContent = "打开相机";
  recordButton.disabled = true;
  statusText.textContent = "等待打开相机";
  releaseWakeLock();
}

async function toggleRecording() {
  if (recorder && recorder.state !== "inactive") {
    stopRecording();
    return;
  }

  await startRecording();
}

async function startRecording() {
  if (!stream) return;

  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    alert("当前浏览器不支持 MediaRecorder 录制。建议换 Safari/Chrome 最新版，或先用电脑浏览器测试。");
    return;
  }

  await runCountdown();
  recordedChunks = [];
  downloadLink.hidden = true;
  downloadLink.removeAttribute("href");
  downloadLink.removeAttribute("download");

  recorder = new MediaRecorder(stream, { mimeType });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  });
  recorder.addEventListener("stop", () => saveRecording(mimeType));
  recorder.start(1000);

  recordingStartedAt = Date.now();
  timerId = window.setInterval(updateTimer, 250);
  updateTimer();

  document.body.classList.add("recording");
  recordButton.textContent = "停止录制";
  statusText.textContent = "正在录制";

  if (autoScrollInput.checked) startScroll();
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  recorder = null;
  stopScroll();
  window.clearInterval(timerId);
  timerId = null;
  document.body.classList.remove("recording");
  recordButton.textContent = "开始录制";
  pauseButton.textContent = "暂停滚动";
  pauseButton.disabled = true;
  statusText.textContent = stream ? "相机已打开" : "等待打开相机";
}

function saveRecording(mimeType) {
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const blob = new Blob(recordedChunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadLink.href = url;
  downloadLink.download = `提示词相机-${stamp}.${extension}`;
  downloadLink.hidden = false;
  downloadLink.textContent = `下载录制视频（${extension.toUpperCase()}）`;
}

function getSupportedMimeType() {
  const types = [
    "video/mp4;codecs=h264,aac",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return types.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type));
}

function startScroll() {
  if (isScrolling) return;
  isScrolling = true;
  pauseButton.disabled = false;
  pauseButton.textContent = "暂停滚动";
  lastScrollFrameAt = performance.now();
  scrollFrame = requestAnimationFrame(stepScroll);
}

function stopScroll() {
  isScrolling = false;
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
}

function toggleScroll() {
  if (isScrolling) {
    stopScroll();
    pauseButton.textContent = "继续滚动";
  } else {
    startScroll();
  }
}

function resetScroll() {
  scriptTrack.scrollTop = 0;
}

function stepScroll(now) {
  if (!isScrolling) return;

  const elapsed = Math.min(80, now - lastScrollFrameAt) / 1000;
  lastScrollFrameAt = now;
  const pixelsPerSecond = Number(speedInput.value);
  const maxScroll = scriptTrack.scrollHeight - scriptTrack.clientHeight;

  if (scriptTrack.scrollTop < maxScroll) {
    scriptTrack.scrollTop += pixelsPerSecond * elapsed;
    scrollFrame = requestAnimationFrame(stepScroll);
  } else {
    stopScroll();
    pauseButton.textContent = "继续滚动";
  }
}

async function runCountdown() {
  for (const value of ["3", "2", "1"]) {
    countdown.textContent = value;
    countdown.hidden = false;
    await wait(700);
  }
  countdown.hidden = true;
}

function updateTimer() {
  const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remain = (seconds % 60).toString().padStart(2, "0");
  timer.textContent = `${minutes}:${remain}`;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  wakeLock.release();
  wakeLock = null;
}

function getCameraErrorMessage(error) {
  if (!window.isSecureContext) {
    return "浏览器要求 HTTPS 才能调用手机摄像头。请把这个网页部署到 HTTPS 地址，或在本机 localhost 测试。";
  }
  if (error && error.name === "NotAllowedError") {
    return "你拒绝了摄像头或麦克风权限。请在浏览器设置里允许后重试。";
  }
  if (error && error.name === "NotFoundError") {
    return "没有找到可用摄像头。";
  }
  return `相机打开失败：${error?.message || "未知错误"}`;
}
