/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

import {GoogleGenAI, GenerateContentResponse, Type} from '@google/genai';
import {marked} from 'marked';

const MODEL_NAME = 'gemini-2.5-flash';

interface TranscriptSegment {
  timestamp?: string;
  speaker?: string;
  text: string;
}
interface Note {
  id: string;
  parsedTranscriptSegments: TranscriptSegment[] | null;
  fullRawResponseText: string; // Original full text from model for transcription, or user input
  polishedNote: string; // Internally, this still represents the summarized/processed content
  timestamp: number;
}

type RawTranscriptFormat =
  | 'text_only'
  | 'timestamps_only'
  | 'speakers_only'
  | 'timestamps_speakers';

class VoiceNotesApp {
  private genAI: GoogleGenAI;
  private mediaRecorder: MediaRecorder | null = null;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private polishedNote: HTMLDivElement; // This element will display the "Summary"
  private newButton: HTMLButtonElement;
  private themeToggleButton: HTMLButtonElement;
  // private themeToggleIcon: HTMLElement; // No longer needed to store as it's static
  private audioChunks: Blob[] = [];
  private isRecording = false;
  private currentNote: Note | null = null;
  private stream: MediaStream | null = null;
  private editorTitle: HTMLDivElement;

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  private uploadButton: HTMLButtonElement;
  private fileUploadInput: HTMLInputElement;
  private downloadButton: HTMLButtonElement;
  private isBusy = false;

  private rawFormatControlsContainer: HTMLDivElement;
  private currentRawFormat: RawTranscriptFormat = 'text_only';


  constructor() {
    this.genAI = new GoogleGenAI({apiKey: process.env.API_KEY!});

    this.recordButton = document.getElementById(
      'recordButton',
    ) as HTMLButtonElement;
    this.recordingStatus = document.getElementById(
      'recordingStatus',
    ) as HTMLDivElement;
    this.rawTranscription = document.getElementById(
      'rawTranscription',
    ) as HTMLDivElement;
    this.polishedNote = document.getElementById(
      'polishedNote',
    ) as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.themeToggleButton = document.getElementById(
      'themeToggleButton',
    ) as HTMLButtonElement;
    this.editorTitle = document.querySelector(
      '.editor-title',
    ) as HTMLDivElement;

    this.recordingInterface = document.querySelector(
      '.recording-interface',
    ) as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById(
      'liveRecordingTitle',
    ) as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById(
      'liveWaveformCanvas',
    ) as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById(
      'liveRecordingTimerDisplay',
    ) as HTMLDivElement;

    this.uploadButton = document.getElementById('uploadButton') as HTMLButtonElement;
    this.fileUploadInput = document.getElementById('fileUploadInput') as HTMLInputElement;
    this.downloadButton = document.getElementById('downloadButton') as HTMLButtonElement;
    
    this.rawFormatControlsContainer = document.getElementById('rawFormatControlsContainer') as HTMLDivElement;


    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    } else {
      console.warn(
        'Live waveform canvas element not found. Visualizer will not work.',
      );
    }

    if (this.recordingInterface) {
      this.statusIndicatorDiv = this.recordingInterface.querySelector(
        '.status-indicator',
      ) as HTMLDivElement;
    } else {
      console.warn('Recording interface element not found.');
      this.statusIndicatorDiv = null;
    }

    this.bindEventListeners();
    this.initTheme();
    this.createNewNote(); 

    this.recordingStatus.textContent = 'Ready to record';
  }

  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.createNewNote());
    this.themeToggleButton.addEventListener('click', () => this.toggleTheme());
    this.uploadButton.addEventListener('click', () => this.handleUploadClick());
    this.fileUploadInput.addEventListener('change', (event) => this.handleFileSelected(event));
    this.downloadButton.addEventListener('click', () => this.handleDownload());
    window.addEventListener('resize', this.handleResize.bind(this));
    
    document.addEventListener('tabchanged', (event) => {
        const customEvent = event as CustomEvent;
        this.handleTabChange(customEvent.detail.activeTab);
    });

    this.rawFormatControlsContainer.querySelectorAll('.format-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const selectedFormat = (e.currentTarget as HTMLButtonElement).dataset.format as RawTranscriptFormat;
            this.setRawTranscriptFormat(selectedFormat);
        });
    });

    if (this.editorTitle) {
        this.editorTitle.addEventListener('focus', () => this.handleEditorTitleFocus());
        this.editorTitle.addEventListener('blur', () => this.handleEditorTitleBlur());
        this.editorTitle.addEventListener('input', () => this.handleEditorTitleInput());
    }
  }

  private handleEditorTitleFocus(): void {
    if (!this.editorTitle) return;
    const placeholder = this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    if (this.editorTitle.textContent === placeholder) {
        this.editorTitle.textContent = '';
    }
    this.editorTitle.classList.remove('placeholder-active');
  }

  private handleEditorTitleBlur(): void {
    if (!this.editorTitle) return;
    const placeholder = this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    if (!this.editorTitle.textContent?.trim()) {
        this.editorTitle.textContent = placeholder;
        this.editorTitle.classList.add('placeholder-active');
    }
  }

  private handleEditorTitleInput(): void {
    if (!this.editorTitle) return;
    const placeholder = this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    if (this.editorTitle.textContent && this.editorTitle.textContent !== placeholder) {
        this.editorTitle.classList.remove('placeholder-active');
    } else if (!this.editorTitle.textContent) { 
        this.editorTitle.classList.add('placeholder-active'); 
    }

    if (this.isRecording && this.liveRecordingTitle && this.recordingInterface.classList.contains('is-live')) {
        const newTitle = this.editorTitle.textContent?.trim();
        this.liveRecordingTitle.textContent = (newTitle && newTitle !== placeholder) ? newTitle : 'New Recording';
    }
  }


  private handleTabChange(activeTab: string): void {
    this.updateDownloadButtonState();
    this.updateRawFormatControlsVisibility();
    if (activeTab === 'rawTranscription' && this.currentNote?.fullRawResponseText) { // Check fullRawResponseText as parsed may be null
        this.renderRawTranscription(); 
    }
  }

  private updateRawFormatControlsVisibility(): void {
    const activeTabButton = document.querySelector('.tab-button.active');
    const isRawTabActive = activeTabButton?.getAttribute('data-tab') === 'rawTranscription';
    // Controls are only shown if there are successfully parsed segments
    const hasParsedSegments = this.currentNote?.parsedTranscriptSegments && this.currentNote.parsedTranscriptSegments.length > 0;
    
    if (isRawTabActive && hasParsedSegments) {
        this.rawFormatControlsContainer.style.display = 'block';
    } else {
        this.rawFormatControlsContainer.style.display = 'none';
    }
  }

  private setRawTranscriptFormat(format: RawTranscriptFormat): void {
    this.currentRawFormat = format;
    this.rawFormatControlsContainer.querySelectorAll('.format-button').forEach(button => {
        button.classList.toggle('active', button.getAttribute('data-format') === format);
    });
    this.renderRawTranscription();
    this.updateDownloadButtonState(); 
  }


  private setBusyState(busy: boolean): void {
    this.isBusy = busy;
    this.recordButton.disabled = busy;
    this.uploadButton.disabled = busy;
    this.newButton.disabled = busy;
    // Removed automatic reset of recordingStatus.textContent to prevent overwriting specific error messages
    this.updateDownloadButtonState();
  }

  private updateDownloadButtonState(): void {
    if (this.isBusy) {
        this.downloadButton.disabled = true;
        return;
    }

    const activeTabButton = document.querySelector('.tab-button.active');
    if (!activeTabButton) {
        this.downloadButton.disabled = true;
        return;
    }
    const activeTab = activeTabButton.getAttribute('data-tab');
    let contentToCheck: string | null = null;
    let placeholder: string | null = null;

    if (activeTab === 'polishedNote' && this.polishedNote) {
        contentToCheck = this.polishedNote.innerText; 
        placeholder = this.polishedNote.getAttribute('placeholder');
    } else if (activeTab === 'rawTranscription' && this.rawTranscription) {
        contentToCheck = this.rawTranscription.innerText; 
        placeholder = this.rawTranscription.getAttribute('placeholder');
    }
    
    const isEmptyOrPlaceholder = !contentToCheck || contentToCheck.trim() === '' || (placeholder && contentToCheck.trim() === placeholder.trim());
    this.downloadButton.disabled = isEmptyOrPlaceholder;
  }


  private handleDownload(): void {
    if (this.downloadButton.disabled) return;

    const activeTabButton = document.querySelector('.tab-button.active');
    if (!activeTabButton) return;

    const activeTab = activeTabButton.getAttribute('data-tab');
    let content = '';
    let fileExtension = '.txt';
    let mimeType = 'text/plain';

    if (activeTab === 'polishedNote') {
      content = this.currentNote?.polishedNote || this.polishedNote.innerText;
      fileExtension = '.md';
      mimeType = 'text/markdown;charset=utf-8';
    } else if (activeTab === 'rawTranscription') {
      content = this.rawTranscription.innerText || ''; // Use innerText to get what's displayed
      fileExtension = '.txt';
      mimeType = 'text/plain;charset=utf-8';
    }

    if (!content.trim() || content.trim() === (activeTab === 'polishedNote' ? this.polishedNote.getAttribute('placeholder') : this.rawTranscription.getAttribute('placeholder'))?.trim() ) {
      return; 
    }

    let filename = (this.editorTitle.textContent?.trim() || 'note');
    const placeholderTitle = this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    if (filename === placeholderTitle || filename === '') {
        filename = 'note';
    }
    filename = filename.replace(/[^\w\s.-]/gi, '_').trim() + fileExtension;


    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }


  private handleUploadClick(): void {
    if (this.isBusy) return;
    this.fileUploadInput.click();
  }

  private async handleFileSelected(event: Event): Promise<void> {
    const fileInput = event.target as HTMLInputElement;
    const file = fileInput.files?.[0];

    if (!file) {
      return;
    }
    if (this.isBusy) {
      fileInput.value = ''; 
      return;
    }
    this.setBusyState(true);
    this.recordingStatus.textContent = 'Preparing to process file...';

    try {
      if (this.isRecording) {
        this.recordingStatus.textContent = 'Stopping current recording...';
        await this.stopRecording(); 
      }
      this.stopLiveDisplay();
      this.clearNoteContentsForNewAudio();
      await this.processAudio(file, file.type);
    } catch (error) {
      console.error('Error during file processing lifecycle:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Avoid overwriting more specific messages like "Transcription parsing failed..."
      if (!this.recordingStatus.textContent?.includes('parsing failed')) {
        if (!errorMsg.toLowerCase().includes('no audio data captured')) {
            this.recordingStatus.textContent = `Error: ${errorMsg}. Please try again.`;
        }
      }
      this.setPlaceholder(this.rawTranscription, true);
      this.setPlaceholder(this.polishedNote, true, true);

    } finally {
      this.setBusyState(false);
      fileInput.value = ''; 
    }
  }

  private setPlaceholder(element: HTMLElement, isActive: boolean, isHtml = false): void {
    const placeholderText = element.getAttribute('placeholder') || '';
    if (isActive) {
        if(isHtml) element.innerHTML = placeholderText; else element.textContent = placeholderText;
        element.classList.add('placeholder-active');
    } else {
        if(isHtml) element.innerHTML = ''; else element.textContent = '';
        element.classList.remove('placeholder-active');
    }
  }

  private clearNoteContentsForNewAudio(): void {
    this.setPlaceholder(this.rawTranscription, true);
    this.setPlaceholder(this.polishedNote, true, true); 

    if (this.editorTitle) {
      const placeholder = this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
      this.editorTitle.textContent = placeholder;
      this.editorTitle.classList.add('placeholder-active');
    }
    if (this.currentNote) {
        this.currentNote.parsedTranscriptSegments = null;
        this.currentNote.fullRawResponseText = '';
        this.currentNote.polishedNote = '';
    }
    this.updateDownloadButtonState();
    this.updateRawFormatControlsVisibility(); 
    this.renderRawTranscription(); 
  }


  private handleResize(): void {
    if (
      this.isRecording &&
      this.liveWaveformCanvas &&
      this.liveWaveformCanvas.style.display === 'block'
    ) {
      requestAnimationFrame(() => {
        this.setupCanvasDimensions();
      });
    }
  }

  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;

    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private initTheme(): void {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
    } else {
      document.body.classList.remove('light-mode');
    }
  }

  private toggleTheme(): void {
    document.body.classList.toggle('light-mode');
    if (document.body.classList.contains('light-mode')) {
      localStorage.setItem('theme', 'light');
    } else {
      localStorage.setItem('theme', 'dark');
    }
  }

  private async toggleRecording(): Promise<void> {
    if (this.isBusy && !this.isRecording) return;

    if (!this.isRecording) {
      await this.startRecording();
    } else {
      this.setBusyState(true); 
      this.recordingStatus.textContent = 'Processing audio...';
      try {
        await this.stopRecording(); 
      } catch (error) {
        console.error('Error during stop process triggered by toggle:', error);
        this.recordingStatus.textContent = `Error stopping: ${error instanceof Error ? error.message : String(error)}`;
        this.isRecording = false;
        this.recordButton.classList.remove('recording');
        this.recordButton.setAttribute('title', 'Start Recording');
        this.stopLiveDisplay();
        this.setBusyState(false);
      }
    }
  }

  private setupAudioVisualizer(): void {
    if (!this.stream || this.audioContext) return;

    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.75;

    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);

    source.connect(this.analyserNode);
  }

  private drawLiveWaveform(): void {
    if (
      !this.analyserNode ||
      !this.waveformDataArray ||
      !this.liveWaveformCtx ||
      !this.liveWaveformCanvas ||
      !this.isRecording
    ) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }

    this.waveformDrawingId = requestAnimationFrame(() =>
      this.drawLiveWaveform(),
    );
    this.analyserNode.getByteFrequencyData(this.waveformDataArray);

    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;

    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5);

    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7));
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));

    let x = 0;

    const recordingColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-recording')
        .trim() || '#ff3b30';
    ctx.fillStyle = recordingColor;

    for (let i = 0; i < numBars; i++) {
      if (x >= logicalWidth) break;

      const dataIndex = Math.floor(i * (bufferLength / numBars));
      const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
      let barHeight = barHeightNormalized * logicalHeight;

      if (barHeight < 1 && barHeight > 0) barHeight = 1;
      barHeight = Math.round(barHeight);

      const y = Math.round((logicalHeight - barHeight) / 2);

      ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
      x += barWidth + barSpacing;
    }
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;

    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);

    this.liveRecordingTimerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      console.warn(
        'One or more live display elements are missing. Cannot start live display.',
      );
      return;
    }

    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';

    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }

    const currentTitle = this.editorTitle.textContent?.trim();
    const placeholder =
      this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    this.liveRecordingTitle.textContent =
      currentTitle && currentTitle !== placeholder
        ? currentTitle
        : 'New Recording';

    this.setupAudioVisualizer();
    this.drawLiveWaveform();

    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50);
  }

  private stopLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      if (this.recordingInterface)
        this.recordingInterface.classList.remove('is-live');
      return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';

    if (this.statusIndicatorDiv)
      this.statusIndicatorDiv.style.display = 'block';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    if (this.waveformDrawingId) {
      cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
      this.liveWaveformCtx.clearRect(
        0,
        0,
        this.liveWaveformCanvas.width,
        this.liveWaveformCanvas.height,
      );
    }

    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') {
        this.audioContext
          .close()
          .catch((e) => console.warn('Error closing audio context', e));
      }
      this.audioContext = null;
    }
    this.analyserNode = null;
    this.waveformDataArray = null;
  }

  private async startRecording(): Promise<void> {
    if (this.isBusy || this.isRecording) return;
    this.setBusyState(true); 
    this.clearNoteContentsForNewAudio();

    try {
      this.audioChunks = [];
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
        this.audioContext = null;
      }

      this.recordingStatus.textContent = 'Requesting microphone access...';

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
      } catch (err) {
        console.warn('Failed with basic constraints, trying fallbacks:', err);
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      this.recordingStatus.textContent = 'Microphone access granted.';


      try {
        this.mediaRecorder = new MediaRecorder(this.stream, {
          mimeType: 'audio/webm',
        });
      } catch (e) {
        console.warn('audio/webm not supported, trying default:', e);
        this.mediaRecorder = new MediaRecorder(this.stream);
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async () => {
        this.stopLiveDisplay();

        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, {
            type: this.mediaRecorder?.mimeType || 'audio/webm',
          });
          try {
            await this.processAudio(audioBlob, audioBlob.type);
          } catch (errProcessing) {
            console.error(
              'Error processing audio from recording (onstop):',
              errProcessing,
            );
            if (!this.recordingStatus.textContent?.includes('parsing failed')) {
              this.recordingStatus.textContent = `Error processing: ${
                errProcessing instanceof Error
                  ? errProcessing.message
                  : String(errProcessing)
              }`;
            }
          } finally {
            this.setBusyState(false);
          }
        } else {
          this.recordingStatus.textContent =
            'No audio data captured. Please try again.';
          this.setBusyState(false);
        }

        if (this.stream) {
          this.stream.getTracks().forEach((track) => {
            track.stop();
          });
          this.stream = null;
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.recordingStatus.textContent = 'Recording...';

      this.recordButton.classList.add('recording');
      this.recordButton.setAttribute('title', 'Stop Recording');

      this.startLiveDisplay();
      this.setBusyState(false); 
    } catch (error) {
      console.error('Error starting recording:', error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'Unknown';

      if (
        errorName === 'NotAllowedError' ||
        errorName === 'PermissionDeniedError'
      ) {
        this.recordingStatus.textContent =
          'Microphone permission denied. Please check browser settings.';
      } else if (
        errorName === 'NotFoundError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Requested device not found'))
      ) {
        this.recordingStatus.textContent =
          'No microphone found. Please connect a microphone.';
      } else if (
        errorName === 'NotReadableError' ||
        errorName === 'AbortError' ||
        (errorName === 'DOMException' &&
          (errorMessage.includes('Failed to allocate audiosource') || errorMessage.includes('Starting audio failed')))
      ) {
        this.recordingStatus.textContent =
          'Cannot access microphone. It may be in use or unavailable.';
      } else {
        this.recordingStatus.textContent = `Error starting recording: ${errorMessage}`;
      }

      this.isRecording = false;
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.stopLiveDisplay();
      this.setBusyState(false); 
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.mediaRecorder && this.isRecording) {
      const currentStream = this.stream; 
      try {
        this.mediaRecorder.stop(); 
        this.isRecording = false;
        this.recordButton.classList.remove('recording');
        this.recordButton.setAttribute('title', 'Start Recording');
      } catch (e) {
        console.error('Error calling mediaRecorder.stop():', e);
        this.isRecording = false;
        this.recordButton.classList.remove('recording');
        this.recordButton.setAttribute('title', 'Start Recording');
        this.stopLiveDisplay(); 
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
            if (this.stream === currentStream) this.stream = null;
        }
        throw new Error(`Failed to stop media recorder: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      if (!this.isRecording) { 
        this.stopLiveDisplay();
      }
    }
  }

  private async processAudio(audioBlob: Blob, mimeType: string): Promise<void> {
    this.recordingStatus.textContent = 'Processing uploaded file...';
    if (audioBlob.size === 0) {
      this.recordingStatus.textContent = 'No audio data captured. Please try again.';
      throw new Error('No audio data captured.');
    }

    try {
      this.recordingStatus.textContent = 'Converting audio...';

      const reader = new FileReader();
      const readResult = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          try {
            const base64data = reader.result as string;
            const base64Portion = base64data.split(',')[1];
            if (!base64Portion) {
                reject(new Error('Failed to extract base64 data from audio.'));
                return;
            }
            resolve(base64Portion);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(reader.error || new Error('FileReader error'));
        reader.onabort = () => reject(new Error('File reading aborted'));
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await readResult;

      await this.getTranscription(base64Audio, mimeType);
    } catch (error) {
      if (error instanceof Error && (error.message.includes('FileReader error') || error.message.includes('File reading aborted') || error.message.includes('Failed to extract base64'))) {
          this.recordingStatus.textContent = `Audio conversion error: ${error.message}.`;
      }
      // If the error is from getTranscription (e.g. API call failed), it will be re-thrown here.
      // If it was a JSON parse error within getTranscription, it's handled gracefully there and not re-thrown.
      throw error; 
    }
  }

  private async getTranscription(
    base64Audio: string,
    mimeType: string,
  ): Promise<void> {
    if (!this.currentNote) {
        throw new Error("Current note is not initialized.");
    }
    let successfullyParsedJson = false;
    try {
      this.recordingStatus.textContent = 'Getting transcription...';
      if (!mimeType) {
        throw new Error("MIME type is missing for transcription.");
      }

      const audioPart = {inlineData: {mimeType: mimeType, data: base64Audio}};
      const textPart = { text: 'Transcribe the audio and identify different speakers. Provide timestamps for each segment if possible.' };
      
      const requestPayload = {
        model: MODEL_NAME,
        contents: { parts: [audioPart, textPart] },
        config: { 
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        timestamp: { type: Type.STRING, description: 'Optional: Start time of the segment.' },
                        speaker: { type: Type.STRING, description: 'Optional: Speaker identifier.' },
                        text: { type: Type.STRING, description: 'The transcribed text.' },
                    },
                    required: ['text'],
                },
            },
        }
      };

      const response: GenerateContentResponse = await this.genAI.models.generateContent(requestPayload);

      let jsonStr = response.text.trim();

      try {
        const parsedSegmentsFromApi: any[] = JSON.parse(jsonStr);
        if (!Array.isArray(parsedSegmentsFromApi)) {
            throw new Error("Parsed JSON is not an array.");
        }

        this.currentNote.parsedTranscriptSegments = parsedSegmentsFromApi.map(s => {
            const segmentText = (typeof s.text === 'string') ? s.text : '';

            let segmentTimestamp: string | undefined = undefined;
            if (s.timestamp && typeof s.timestamp === 'string' && s.timestamp.trim() !== '') {
                segmentTimestamp = s.timestamp.trim();
            }

            let segmentSpeaker: string | undefined = undefined;
            // Robust speaker parsing: accept string or number, convert to string
            if (s.speaker !== undefined && s.speaker !== null) {
                const speakerVal = String(s.speaker).trim();
                if (speakerVal !== '') {
                    segmentSpeaker = speakerVal;
                }
            }

            return {
                timestamp: segmentTimestamp,
                speaker: segmentSpeaker,
                text: segmentText
            };
        }).filter(s => s.text || s.timestamp || s.speaker); // Ensure segments have at least some data

        if (this.currentNote.parsedTranscriptSegments.length === 0 && parsedSegmentsFromApi.length > 0) {
             // This case might happen if all segments only had empty strings for all fields.
             // Treat as parsing failure for practical purposes, fall back to raw text.
             throw new Error("Parsed segments resulted in no usable data, though JSON was valid.");
        }


        this.currentNote.fullRawResponseText = this.currentNote.parsedTranscriptSegments.map(s => {
            let line = '';
            if(s.timestamp) line += `[${s.timestamp}] `;
            if(s.speaker) line += `Speaker ${s.speaker}: `;
            line += s.text;
            return line;
        }).join('\n');
        successfullyParsedJson = true;

      } catch (e) {
        console.warn("Failed to parse transcription as JSON or JSON structure is invalid/empty. Original response text (snippet):", jsonStr.substring(0, 500), "Error:", e);
        this.recordingStatus.textContent = 'Transcription parsing failed. Displaying raw text.';
        this.currentNote.parsedTranscriptSegments = null;
        this.currentNote.fullRawResponseText = jsonStr; 
      }

      this.renderRawTranscription();
      this.updateRawFormatControlsVisibility();

      await this.getPolishedNote(); 

    } catch (error) { // This outer catch handles API call errors or other critical failures
      console.error('Error getting transcription (API or critical failure):', error);
      this.setPlaceholder(this.rawTranscription, true);
      this.setPlaceholder(this.polishedNote, true, true);
      this.polishedNote.innerHTML = `<p><em>Error during transcription: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      this.polishedNote.classList.remove('placeholder-active');

      // Avoid overwriting specific parsing failure message if that already occurred
      if (!this.recordingStatus.textContent?.includes('parsing failed')) {
         this.recordingStatus.textContent = `Transcription error: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (this.currentNote) {
        this.currentNote.parsedTranscriptSegments = null;
        this.currentNote.fullRawResponseText = ''; // Clear on critical API error
      }
      this.renderRawTranscription(); 
      this.updateRawFormatControlsVisibility();
      throw error; // Re-throw critical errors to be caught by caller
    } finally {
        this.updateDownloadButtonState();
    }
  }

  private escapeHtml(unsafe: string): string {
    if (typeof unsafe !== 'string') {
        return '';
    }
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
  }

  private renderRawTranscription(): void {
    if (!this.currentNote || (!this.currentNote.parsedTranscriptSegments && !this.currentNote.fullRawResponseText)) {
        this.setPlaceholder(this.rawTranscription, true);
        this.updateRawFormatControlsVisibility();
        return;
    }

    const segments = this.currentNote.parsedTranscriptSegments;
    let htmlContent = '';

    if (segments && segments.length > 0) {
        segments.forEach(segment => {
            let segmentHtml = '<div class="transcript-segment">';
            let metaInfo = '';
            if (this.currentRawFormat === 'timestamps_speakers' || this.currentRawFormat === 'timestamps_only') {
                if (segment.timestamp) {
                    metaInfo += `<span class="ts-timestamp">${this.escapeHtml(segment.timestamp)}</span> `;
                }
            }
            if (this.currentRawFormat === 'timestamps_speakers' || this.currentRawFormat === 'speakers_only') {
                if (segment.speaker) {
                    metaInfo += `<span class="ts-speaker">Speaker ${this.escapeHtml(segment.speaker)}:</span> `;
                }
            }
            if (metaInfo) {
                segmentHtml += `<span class="ts-meta">${metaInfo.trim()}</span>`;
            }
            const escapedText = this.escapeHtml(segment.text);
            segmentHtml += `<span class="ts-text">${escapedText.replace(/\n/g, '<br>')}</span>`;
            segmentHtml += '</div>';
            htmlContent += segmentHtml;
        });
        this.rawTranscription.innerHTML = htmlContent;
        this.rawTranscription.classList.remove('placeholder-active');
    } else if (this.currentNote.fullRawResponseText) { 
        this.rawTranscription.textContent = this.currentNote.fullRawResponseText;
        this.rawTranscription.classList.remove('placeholder-active');
    } else {
        this.setPlaceholder(this.rawTranscription, true);
    }
    this.updateRawFormatControlsVisibility(); // Ensure controls are hidden if segments are null/empty
  }


  private async getPolishedNote(): Promise<void> { 
    if (!this.currentNote) {
        throw new Error("Current note is not initialized.");
    }
    try {
      const rawText = this.currentNote.fullRawResponseText || ''; // fullRawResponseText is the source of truth

      if (!rawText.trim()) {
        this.recordingStatus.textContent = 'No transcription to summarize.';
        this.setPlaceholder(this.polishedNote, true, true);
        this.currentNote.polishedNote = '';
        return;
      }

      this.recordingStatus.textContent = 'Summarizing note...';

      const prompt = `Take this raw transcription and create a concise summary.
                    Focus on key points and actions.
                    Format any lists or bullet points properly. Use Markdown for formatting (headings, bold, italics, lists).
                    Ensure the output is only the summary content in Markdown format.
                    Raw Transcription:
                    "${rawText}"`;

      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: [{parts: [{text: prompt}]}],
      });

      const summaryMarkdown = response.text;

      if (summaryMarkdown) {
        this.polishedNote.innerHTML = await marked(summaryMarkdown);
        this.polishedNote.classList.remove('placeholder-active');
        this.currentNote.polishedNote = summaryMarkdown; 
        this.recordingStatus.textContent = 'Summary ready.';
      } else {
        this.recordingStatus.textContent = 'Summarizing returned empty.';
        this.polishedNote.innerHTML = `<p><em>Summarizing returned no content.</em></p>`;
        if (!this.polishedNote.innerHTML.trim()) { // Check if it's actually empty after setting
          this.polishedNote.classList.add('placeholder-active');
        } else {
          this.polishedNote.classList.remove('placeholder-active');
        }
        this.currentNote.polishedNote = '';
      }
    } catch (error) {
      console.error('Error summarizing note:', error);
      this.recordingStatus.textContent = `Summarizing error: ${error instanceof Error ? error.message : String(error)}`;
      this.polishedNote.innerHTML = `<p><em>Error during summary generation: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      this.polishedNote.classList.remove('placeholder-active');
      if (this.currentNote) this.currentNote.polishedNote = '';
      throw error; 
    } finally {
        this.updateDownloadButtonState();
    }
  }

  private createNewNote(): void {
    if (this.isBusy) return;
    if (this.isRecording) {
        this.recordingStatus.textContent = "Please stop recording before creating a new note.";
        return;
    }
    this.currentNote = {
      id: Date.now().toString(),
      parsedTranscriptSegments: null,
      fullRawResponseText: '',
      polishedNote: '',
      timestamp: Date.now(),
    };
    this.clearNoteContentsForNewAudio(); 
    this.recordingStatus.textContent = 'New note created. Ready to record.';
    this.setRawTranscriptFormat('text_only');
    
    if (this.editorTitle) {
        const placeholder = this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
        this.editorTitle.textContent = placeholder; 
        this.editorTitle.classList.add('placeholder-active'); 
        // editorTitle.focus() can cause issues if an action is still processing.
        // Let blur/focus handlers manage placeholder.
    }
    this.updateDownloadButtonState();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new VoiceNotesApp();
});