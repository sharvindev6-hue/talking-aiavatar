import { TalkingHead } from "@met4citizen/talkinghead";

// Served locally — models.readyplayer.me is blocked on some networks
const AVATAR_URL = "/avatars/brunette.glb";

const MOOD_MAP = {
  neutral: "neutral",
  happy: "happy",
  sad: "sad",
  angry: "angry",
  fear: "fear",
  disgust: "disgust",
  love: "love",
  sleep: "sleep",
  friendly: "happy",
  concerned: "sad",
  curious: "happy",
};

const GESTURE_MAP = {
  handup: "handup",
  index: "index",
  ok: "ok",
  thumbup: "thumbup",
  thumbdown: "thumbdown",
  side: "side",
  shrug: "shrug",
  wave: "handup",
  nod: "ok",
  none: null,
};

export class AvatarController {
  constructor(container, { onStateChange } = {}) {
    this.container = container;
    this.onStateChange = onStateChange;
    this.head = null;
    this.isStreaming = false;
    this.a2fEnabled = false;
  }

  async init() {
    this.head = new TalkingHead(this.container, {
      cameraView: "upper",
      lipsyncLang: "en",
      lipsyncModules: ["en"],
      pcmSampleRate: 22050,
    });

    await this.head.showAvatar({
      url: AVATAR_URL,
      body: "F",
    });

    this.head.start();
    this._startIdleBehavior();
    this._setState("idle");
    return this.head;
  }

  _startIdleBehavior() {
    const blink = () => {
      if (!this.head) return;
      this.head.makeEyeContact(1200 + Math.random() * 2000);
      setTimeout(blink, 3000 + Math.random() * 5000);
    };
    blink();

    const microGesture = () => {
      if (!this.head || this.head.isStreaming) {
        setTimeout(microGesture, 4000);
        return;
      }
      if (Math.random() < 0.35) {
        this.head.playGesture("side", 1.2, false, 800);
      }
      setTimeout(microGesture, 8000 + Math.random() * 12000);
    };
    setTimeout(microGesture, 6000);
  }

  async ensureStreamSession() {
    if (this.isStreaming) return;

    this.head.streamStart(
      {
        sampleRate: 22050,
        gain: 0.9,
        lipsyncType: "words",
        lipsyncLang: "en",
        mood: "neutral",
        waitForAudioChunks: true,
      },
      () => this._setState("speaking"),
      () => this._setState("idle"),
      null
    );

    this.isStreaming = true;
  }

  async speakWithMetadata({ say, emotion, gesture }) {
    await this.ensureStreamSession();

    const mood = MOOD_MAP[emotion] || "neutral";
    this.head.setMood(mood);
    this.head.lookAtCamera(3000);

    if (gesture && GESTURE_MAP[gesture]) {
      this.head.playGesture(GESTURE_MAP[gesture], 2.5, false, 600);
    }

    return { say, mood, gesture };
  }

  feedAudioChunk(chunk) {
    if (!this.head?.isStreaming) return;
    this.head.streamAudio({ audio: chunk });
  }

  feedWords(words, wtimes, wdurations) {
    if (!this.head?.isStreaming) return;
    this.head.streamAudio({ words, wtimes, wdurations });
  }

  notifySpeechEnd() {
    if (!this.head?.isStreaming) return;
    this.head.streamNotifyEnd();
  }

  interrupt() {
    if (this.head?.isStreaming) {
      this.head.streamInterrupt();
    }
    this._setState("idle");
  }

  stopSession() {
    if (this.head?.isStreaming) {
      this.head.streamStop();
      this.isStreaming = false;
    }
    this._setState("idle");
  }

  setA2FEnabled(enabled) {
    this.a2fEnabled = enabled;
  }

  _setState(state) {
    this.onStateChange?.(state);
  }
}
