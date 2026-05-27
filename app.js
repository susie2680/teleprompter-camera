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
let recordingStream = null;
let recordingCanvas = null;
let recordingContext = null;
let drawFrame = null;
let recordingStartedAt = 0;
let timerId = null;
let scrollFrame = null;
let lastScrollFrameAt = 0;
let scriptOffset = 0;
let isScrolling = false;
let wakeLock = null;
let activeRecorderMimeType = "video/mp4";

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
  const promptOpacity = Number(opacityInput.value) / 100;
  document.documentElement.style.setProperty("--prompt-bg", `rgba(7, 9, 13, ${promptOpacity})`);
  document.documentElement.style.setProperty("--prompt-border", `rgba(255, 255, 255, ${promptOpacity * 0.28})`);
  document.documentElement.style.setProperty("--prompt-shadow", `rgba(0, 0, 0, ${promptOpacity * 0.42})`);
  document.documentElement.style.setProperty("--prompt-blur", promptOpacity < 0.08 ? "none" : "blur(8px)");
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
        facingMode: { ideal: "user" },
        frameRate: { ideal: 24, max: 30 },
        resizeMode: { ideal: "none" }
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

  const recorderOptions = getRecorderOptions();
  if (!window.MediaRecorder) {
    alert("当前浏览器不支持 MediaRecorder 录制。建议换 Safari/Chrome 最新版，或先用电脑浏览器测试。");
    return;
  }

  resetScroll();
  await runCountdown();
  countdown.hidden = true;
  countdown.style.display = "none";
  recordedChunks = [];
  downloadLink.hidden = true;
  downloadLink.removeAttribute("href");
  downloadLink.removeAttribute("download");

  recordingStream = stream;
  recorder = new MediaRecorder(recordingStream, recorderOptions);
  activeRecorderMimeType = recorder.mimeType || recorderOptions.mimeType || "video/mp4";
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    saveRecording(activeRecorderMimeType);
    recorder = null;
    recordButton.disabled = false;
  });
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
    recordButton.disabled = true;
    statusText.textContent = "正在保存视频";
    try {
      recorder.requestData();
    } catch {}
    recorder.stop();
  }
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
  if (!recordedChunks.length) {
    downloadLink.hidden = true;
    statusText.textContent = "录制失败，请重试";
    alert("这次录制没有生成视频数据。请刷新页面后重试，或换 Chrome/Safari 最新版测试。");
    return;
  }

  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const blob = new Blob(recordedChunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadLink.href = url;
  downloadLink.download = `提示词相机-${stamp}.${extension}`;
  downloadLink.hidden = false;
  downloadLink.textContent = `下载录制视频（${extension.toUpperCase()}）`;
}

function getRecorderOptions() {
  if (isIOS()) return {};

  const baseOptions = {
    audioBitsPerSecond: 64000,
    videoBitsPerSecond: 1500000
  };

  const types = [
    "video/mp4;codecs=h264,aac",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  const mimeType = types.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type));
  return mimeType ? { ...baseOptions, mimeType } : baseOptions;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function createRecordingStream() {
  if (!HTMLCanvasElement.prototype.captureStream || !preview.videoWidth || !preview.videoHeight) {
    return stream;
  }

  const size = getRecordingSize();
  recordingCanvas = document.createElement("canvas");
  recordingCanvas.width = size.width;
  recordingCanvas.height = size.height;
  recordingContext = recordingCanvas.getContext("2d", { alpha: false });

  const paint = () => {
    drawVideoCover(recordingContext, preview, recordingCanvas.width, recordingCanvas.height);
    drawFrame = requestAnimationFrame(paint);
  };
  paint();

  const canvasStream = recordingCanvas.captureStream(30);
  const tracks = [
    ...canvasStream.getVideoTracks(),
    ...stream.getAudioTracks()
  ];
  return new MediaStream(tracks);
}

function stopCanvasRecording() {
  if (drawFrame) cancelAnimationFrame(drawFrame);
  drawFrame = null;

  if (recordingStream && recordingStream !== stream) {
    recordingStream.getVideoTracks().forEach((track) => track.stop());
  }
  recordingStream = null;
  recordingCanvas = null;
  recordingContext = null;
}

function getRecordingSize() {
  const rect = preview.getBoundingClientRect();
  const isPortrait = rect.height >= rect.width;
  return isPortrait
    ? { width: 1080, height: 1920 }
    : { width: 1920, height: 1080 };
}

function drawVideoCover(context, video, targetWidth, targetHeight) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return;

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;

  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  let cropX = 0;
  let cropY = 0;

  if (sourceRatio > targetRatio) {
    cropWidth = sourceHeight * targetRatio;
    cropX = (sourceWidth - cropWidth) / 2;
  } else {
    cropHeight = sourceWidth / targetRatio;
    cropY = (sourceHeight - cropHeight) / 2;
  }

  context.save();
  if (mirrorInput.checked) {
    context.translate(targetWidth, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
  context.restore();
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
  scriptOffset = 0;
  scriptText.style.transform = "translateY(0)";
}

function stepScroll(now) {
  if (!isScrolling) return;

  const elapsed = Math.min(80, now - lastScrollFrameAt) / 1000;
  lastScrollFrameAt = now;
  const pixelsPerSecond = Number(speedInput.value);
  const readableHeight = scriptTrack.clientHeight - 52;
  const maxScroll = Math.max(0, scriptText.offsetHeight - readableHeight);

  if (scriptOffset < maxScroll) {
    scriptOffset = Math.min(maxScroll, scriptOffset + pixelsPerSecond * elapsed);
    scriptText.style.transform = `translateY(${-scriptOffset}px)`;
    scrollFrame = requestAnimationFrame(stepScroll);
  } else {
    stopScroll();
    pauseButton.textContent = "继续滚动";
  }
}

async function runCountdown() {
  countdown.hidden = false;
  countdown.style.display = "grid";
  for (const value of ["3", "2", "1"]) {
    countdown.textContent = value;
    await wait(700);
  }
  countdown.hidden = true;
  countdown.style.display = "none";
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
