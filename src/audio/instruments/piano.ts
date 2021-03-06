import { AhdEnvelope, AhdsrEnvelope, ENVELOPE_AHD, ENVELOPE_AHDSR } from "../nodes/envelopes";
import { InstrumentSynth } from "../nodes/InstrumentSynth";
import { toFrequency } from "../utils";
import { AFTER_RELEASE } from "../audioRender";
import { CompleteNote, IncompleteNote } from "../../bridge/decoder";

export class Piano extends InstrumentSynth<"piano"> {
  protected instrument: "piano" = "piano";

  private harmonicWave: PeriodicWave = null as any;

  async setup(ctx: BaseAudioContext, destination: AudioNode): Promise<void> {
    const real = new Float32Array(15);
    const imag = new Float32Array(15);
    real.fill(1);
    imag.fill(0);
    real[0] = 0;
    this.harmonicWave = ctx.createPeriodicWave(real, imag);
  }

  async loadNote(note: CompleteNote, ctx: BaseAudioContext, destination: AudioNode): Promise<void> {
    const node = new PianoNode(ctx, this.harmonicWave);
    node.frequencyParam.value = toFrequency(note.pitch);
    node.connect(destination);
    node.schedule(note);
  }

  async loadIncompleteNote(note: IncompleteNote, ctx: BaseAudioContext, destination: AudioNode): Promise<void> {
    const node = new PianoNode(ctx, this.harmonicWave);
    node.frequencyParam.value = toFrequency(note.pitch);
    node.connect(destination);
    node.scheduleIncomplete(note);
  }
}

class PianoNode {
  private static readonly VOLUME = 0.21;
  private static readonly DETUNE = 1.003;
  private static readonly LOW_FREQ_MULT = 0.9997;
  private static readonly HIGH_FREQ_MULT = 1.0008;

  private static readonly LOW_PASS_ENVELOPE: ENVELOPE_AHD = {
    attack: 0,
    hold: 0.01,
    decay: 0.5
  }

  private readonly idealFrequency: ConstantSourceNode;
  readonly frequencyParam: AudioParam;

  private readonly lowFrequency: GainNode;
  private readonly midFrequency: GainNode;
  private readonly highFrequency: GainNode;

  private readonly lowTricord: TricordNode;
  private readonly midTricord: TricordNode;
  private readonly highTricord: TricordNode;
  private readonly hammer: HammerNode;

  private readonly lowpass: BiquadFilterNode;
  private lowpassEnvelope: AhdEnvelope;

  private readonly output: GainNode;

  constructor(ctx: BaseAudioContext, harmonicWave: PeriodicWave) {
    this.idealFrequency = ctx.createConstantSource();
    this.frequencyParam = this.idealFrequency.offset;

    this.midFrequency = ctx.createGain();
    this.midFrequency.gain.value = PianoNode.DETUNE;
    this.idealFrequency.connect(this.midFrequency);

    this.lowFrequency = ctx.createGain();
    this.lowFrequency.gain.value = PianoNode.LOW_FREQ_MULT;
    this.midFrequency.connect(this.lowFrequency);

    this.highFrequency = ctx.createGain();
    this.highFrequency.gain.value = PianoNode.HIGH_FREQ_MULT;
    this.midFrequency.connect(this.highFrequency);

    this.lowTricord = new TricordNode(ctx, harmonicWave);
    this.midTricord = new TricordNode(ctx, harmonicWave);
    this.highTricord = new TricordNode(ctx, harmonicWave);

    this.lowFrequency.connect(this.lowTricord.frequencyParam);
    this.midFrequency.connect(this.midTricord.frequencyParam);
    this.highFrequency.connect(this.highTricord.frequencyParam);

    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpassEnvelope = new AhdEnvelope(ctx, 30, PianoNode.LOW_PASS_ENVELOPE);
    this.midFrequency.connect(this.lowpassEnvelope.input);
    this.lowpassEnvelope.connect(this.lowpass.frequency);

    this.lowTricord.connect(this.lowpass);
    this.midTricord.connect(this.lowpass);
    this.highTricord.connect(this.lowpass);

    this.hammer = new HammerNode(ctx);
    this.midFrequency.connect(this.hammer.frequencyParam);

    this.output = ctx.createGain();
    this.output.gain.value = PianoNode.VOLUME;
    this.lowpass.connect(this.output);
    this.hammer.connect(this.output);
  }

  connect(destinationNode: AudioParam | AudioNode, output?: number, input?: number): PianoNode {
    if (destinationNode instanceof AudioParam) {
      this.output.connect(destinationNode, output);
    } else {
      this.output.connect(destinationNode, output, input);
    }
    return this;
  }

  schedule(note: CompleteNote): void {
    this.idealFrequency.start(Math.max(0, note.startTime));
    this.lowpassEnvelope.schedule(1, note.startTime);

    const stopTime1 = this.lowTricord.schedule(note);
    const stopTime2 = this.midTricord.schedule(note);
    const stopTime3 = this.highTricord.schedule(note);
    const stopTime4 = this.hammer.schedule(note);

    const stopTime = Math.max(stopTime1, stopTime2, stopTime3, stopTime4);
    this.idealFrequency.stop(stopTime);
  }

  scheduleIncomplete(note: IncompleteNote): void {
    this.idealFrequency.start(Math.max(0, note.startTime));
    this.lowpassEnvelope.schedule(1, note.startTime);

    this.lowTricord.scheduleIncomplete(note);
    this.midTricord.scheduleIncomplete(note);
    this.highTricord.scheduleIncomplete(note);
    this.hammer.schedule(note);
  }
} 

class TricordNode {
  private static readonly FUNDAMENTAL_VOLUME = 0.2;
  private static readonly HARMONIC_VOLUME = 0.1;
  private static readonly FUNDAMENTAL_ENVELOPE: ENVELOPE_AHDSR = {
    attack: 0.003,
    hold: 0.01,
    decay: 2,
    sustain: 0,
    release: 0.4
  };
  private static readonly HARMONIC_ENVELOPE: ENVELOPE_AHDSR = {
    attack: 0.003,
    hold: 0,
    decay: 1.8,
    sustain: 0,
    release: 0.2
  }

  private readonly fundamentalFrequency: ConstantSourceNode;
  readonly frequencyParam: AudioParam;

  private readonly fundamentalOscillator: OscillatorNode;
  private readonly fundamentalEnvelope: AhdsrEnvelope;

  private readonly harmonicOscillator: OscillatorNode;
  private readonly harmonicEnvelope: AhdsrEnvelope;


  constructor(ctx: BaseAudioContext, harmonicWave: PeriodicWave) {
    this.fundamentalFrequency = ctx.createConstantSource();
    this.frequencyParam = this.fundamentalFrequency.offset;

    this.fundamentalOscillator = ctx.createOscillator();
    this.fundamentalOscillator.frequency.value = 0;
    this.fundamentalFrequency.connect(this.fundamentalOscillator.frequency);
    this.fundamentalEnvelope = new AhdsrEnvelope(ctx, TricordNode.FUNDAMENTAL_VOLUME, TricordNode.FUNDAMENTAL_ENVELOPE);
    this.fundamentalOscillator.connect(this.fundamentalEnvelope.input);

    this.harmonicOscillator = ctx.createOscillator();
    this.harmonicOscillator.frequency.value = 0;
    this.fundamentalFrequency.connect(this.harmonicOscillator.frequency)
    this.harmonicOscillator.setPeriodicWave(harmonicWave);
    this.harmonicEnvelope = new AhdsrEnvelope(ctx, TricordNode.HARMONIC_VOLUME, TricordNode.HARMONIC_ENVELOPE);
    this.harmonicOscillator.connect(this.harmonicEnvelope.input);
  }

  connect(destinationNode: AudioParam | AudioNode, output?: number, input?: number): TricordNode {
    if (destinationNode instanceof AudioParam) {
      this.fundamentalEnvelope.connect(destinationNode, output);
      this.harmonicEnvelope.connect(destinationNode, output);
    } else {
      this.fundamentalEnvelope.connect(destinationNode, output, input);
      this.harmonicEnvelope.connect(destinationNode, output, input);
    }
    return this;
  }

  schedule({ startTime, endTime: releaseTime, volume }: CompleteNote): number {
    const fundamentalStopTime = releaseTime + AFTER_RELEASE * TricordNode.FUNDAMENTAL_ENVELOPE.release;
    this.fundamentalFrequency.start(Math.max(0, startTime));
    this.fundamentalFrequency.stop(fundamentalStopTime);
    this.fundamentalOscillator.start(Math.max(0, startTime));
    this.fundamentalOscillator.stop(fundamentalStopTime);
    this.fundamentalEnvelope.schedule(volume, startTime, releaseTime);

    const harmonicStopTime = releaseTime + AFTER_RELEASE * TricordNode.HARMONIC_ENVELOPE.release;
    this.harmonicOscillator.start(Math.max(0, startTime));
    this.harmonicOscillator.stop(harmonicStopTime);
    this.harmonicEnvelope.schedule(volume, startTime, releaseTime);

    return Math.max(fundamentalStopTime, harmonicStopTime);
  }

  scheduleIncomplete({ startTime, volume }: IncompleteNote): number {
    this.fundamentalFrequency.start(Math.max(0, startTime));
    this.fundamentalOscillator.start(Math.max(0, startTime));
    this.fundamentalEnvelope.schedule(volume, startTime, 1 * 1000 * 1000);

    this.harmonicOscillator.start(Math.max(0, startTime));
    this.harmonicEnvelope.schedule(volume, startTime, 1 * 1000 * 1000);

    return 0;
  }
}

class HammerNode {
  private static readonly VOLUME = 0.15;
  private static readonly ENVELOPE: ENVELOPE_AHD = {
    attack: 0,
    hold: 0.002,
    decay: 0.1,
  };
  private static readonly DETUNE = 1;

  private readonly frequency: ConstantSourceNode;
  readonly frequencyParam: AudioParam;

  private readonly oscillator: OscillatorNode;
  private readonly oscillatorFrequency: GainNode;
  private readonly envelope: AhdEnvelope;

  constructor(ctx: BaseAudioContext) {
    this.frequency = ctx.createConstantSource();
    this.frequencyParam = this.frequency.offset;

    this.oscillator = ctx.createOscillator();
    this.oscillator.type = "sawtooth";
    this.oscillator.frequency.value = 0;
    this.oscillatorFrequency = ctx.createGain();
    this.oscillatorFrequency.gain.value = HammerNode.DETUNE;
    this.oscillatorFrequency.connect(this.oscillator.frequency);
    this.frequency.connect(this.oscillatorFrequency);

    this.envelope = new AhdEnvelope(ctx, HammerNode.VOLUME, HammerNode.ENVELOPE);
    this.oscillator.connect(this.envelope.input);
  }

  connect(destinationNode: AudioParam | AudioNode, output?: number, input?: number): HammerNode {
    if (destinationNode instanceof AudioParam) {
      this.envelope.connect(destinationNode, output);
    } else {
      this.envelope.connect(destinationNode, output, input);
    }
    return this;
  }

  schedule({ startTime, volume }: CompleteNote | IncompleteNote): number {
    const stopTime = startTime + HammerNode.ENVELOPE.hold + AFTER_RELEASE * HammerNode.ENVELOPE.decay;
    if (stopTime > 0) {
      this.frequency.start(Math.max(0, startTime));
      this.frequency.stop(stopTime);
      this.oscillator.start(Math.max(0, startTime));
      this.oscillator.stop(stopTime);
      this.envelope.schedule(volume, startTime);
    }
    return stopTime;
  }
}