export class SpeechRecognizer {
  constructor({ onResult, onStart, onEnd, onError } = {}) {
    this.onResult = onResult;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.onError = onError;
    this.recognition = null;
    this.listening = false;
    this.supported = "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }

  start() {
    if (!this.supported || this.listening) return false;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-US";

    this.recognition.onstart = () => {
      this.listening = true;
      this.onStart?.();
    };

    this.recognition.onresult = (event) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript;
        else interim += transcript;
      }

      this.onResult?.({ interim, final });
    };

    this.recognition.onerror = (event) => {
      this.listening = false;
      this.onError?.(event.error);
    };

    this.recognition.onend = () => {
      this.listening = false;
      this.onEnd?.();
    };

    this.recognition.start();
    return true;
  }

  stop() {
    if (this.recognition && this.listening) {
      this.recognition.stop();
    }
  }

  isListening() {
    return this.listening;
  }
}
