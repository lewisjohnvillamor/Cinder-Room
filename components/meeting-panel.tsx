"use client";

import {
  Camera,
  CameraSlash,
  ClosedCaptioning,
  ChartBar,
  Gear,
  HandPalm,
  LockKey,
  Microphone,
  MicrophoneSlash,
  MonitorArrowUp,
  PhoneDisconnect,
  PictureInPicture,
  PushPin,
  Question,
  ShieldCheck,
  SidebarSimple,
  Smiley,
  StopCircle,
  UserMinus,
  VideoCamera,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalE2EEKeyProvider,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
} from "livekit-client";
import type { MeetingSignal } from "./room-app";
import { useAccessibleDialog } from "./use-accessible-dialog";

type AttachableTrack = {
  kind: string;
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): HTMLMediaElement[];
};

type MeetingPerson = {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  quality?: string;
  camera?: AttachableTrack;
  microphone?: AttachableTrack;
  screen?: AttachableTrack;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type MediaCredentials = {
  serverUrl: string;
  participantToken: string;
};

const MAX_ACTIVE_CAMERAS = 6;

function base64UrlToBytes(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function deriveMediaKey(encodedRoomKey: string, roomId: string) {
  const material = await crypto.subtle.importKey("raw", base64UrlToBytes(encodedRoomKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode("cinder-media-v1"),
    info: new TextEncoder().encode(roomId),
  }, material, 256);
  return bytesToBase64Url(new Uint8Array(bits));
}

async function decryptParticipantName(roomKey: CryptoKey, encryptedAlias: string) {
  try {
    const packed = base64UrlToBytes(encryptedAlias);
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, roomKey, packed.slice(12));
    const parsed = JSON.parse(new TextDecoder().decode(clear)) as { name?: string };
    return parsed.name?.slice(0, 40) || "Encrypted participant";
  } catch {
    return "Encrypted participant";
  }
}

function publicationTrack(participant: Participant, source: Track.Source) {
  return participant.getTrackPublication(source)?.track as AttachableTrack | undefined;
}

function VideoTrackView({ track, muted, className }: { track: AttachableTrack; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function AudioTrackSink({ track }: { track: AttachableTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

export default function MeetingPanel({
  open,
  intent,
  roomId,
  roomKey,
  encodedKey,
  encryptedAlias,
  ownName,
  onMinimize,
  onCallEnded,
  onFallbackPresent,
  onRequestPresent,
  onReleasePresent,
  socketId,
  httpCapability,
  isHost,
  participants,
  meetingSignals,
  moderationCommand,
  admissionLocked,
  pendingPeople,
  onMeetingSignal,
  onAdmissionLock,
  onAdmissionDecision,
  onModerate,
}: {
  open: boolean;
  intent: "video" | "audio" | "present";
  roomId: string;
  roomKey: CryptoKey;
  encodedKey: string;
  encryptedAlias: string;
  ownName: string;
  onMinimize: () => void;
  onCallEnded: () => void;
  onFallbackPresent: () => void;
  onRequestPresent: () => Promise<{ ok: boolean; error?: string }>;
  onReleasePresent: () => void;
  socketId: string;
  httpCapability: string;
  isHost: boolean;
  participants: Array<{ id: string; name: string }>;
  meetingSignals: MeetingSignal[];
  moderationCommand: { id: string; command: "mute" | "remove"; reason: string } | null;
  admissionLocked: boolean;
  pendingPeople: Array<{ id: string; name: string }>;
  onMeetingSignal: (signal: Omit<MeetingSignal, "id" | "createdAt" | "senderId" | "sender">) => Promise<void>;
  onAdmissionLock: (locked: boolean) => void;
  onAdmissionDecision: (target: string, allow: boolean) => void;
  onModerate: (target: string, command: "mute" | "remove") => void;
}) {
  const roomRef = useRef<Room | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [microphoneOn, setMicrophoneOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [people, setPeople] = useState<MeetingPerson[]>([]);
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraDevice, setCameraDevice] = useState("");
  const [microphoneDevice, setMicrophoneDevice] = useState("");
  const [speakerDevice, setSpeakerDevice] = useState("");
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [layout, setLayout] = useState<"auto" | "grid" | "spotlight">("auto");
  const [pinnedId, setPinnedId] = useState("");
  const [drawer, setDrawer] = useState<"people" | "activities" | "settings" | null>(null);
  const [questionDraft, setQuestionDraft] = useState("");
  const [pollDraft, setPollDraft] = useState("");
  const [captionsOn, setCaptionsOn] = useState(false);
  const [captionsConfirmOpen, setCaptionsConfirmOpen] = useState(false);
  const [previewEnabled, setPreviewEnabled] = useState(false);

  const minimizeMeeting = useCallback(() => {
    previewStreamRef.current?.getTracks().forEach((track) => track.stop());
    previewStreamRef.current = null;
    setPreviewEnabled(false);
    onMinimize();
  }, [onMinimize]);

  const closeTopMeetingDialog = useCallback(() => {
    if (captionsConfirmOpen) setCaptionsConfirmOpen(false);
  }, [captionsConfirmOpen]);
  useAccessibleDialog(captionsConfirmOpen, closeTopMeetingDialog, "captions");

  const refresh = useCallback(async (room: Room) => {
    const participants: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    const activeIds = new Set(room.activeSpeakers.map((participant) => participant.identity));
    const next = await Promise.all(participants.map(async (participant) => ({
      identity: participant.identity,
      name: participant === room.localParticipant
        ? ownName
        : await decryptParticipantName(roomKey, participant.metadata || ""),
      isLocal: participant === room.localParticipant,
      speaking: activeIds.has(participant.identity),
      quality: String(participant.connectionQuality ?? "unknown"),
      camera: publicationTrack(participant, Track.Source.Camera),
      microphone: publicationTrack(participant, Track.Source.Microphone),
      screen: publicationTrack(participant, Track.Source.ScreenShare),
    })));
    setPeople(next);
    setCameraOn(room.localParticipant.isCameraEnabled);
    setMicrophoneOn(room.localParticipant.isMicrophoneEnabled);
    setScreenOn(room.localParticipant.isScreenShareEnabled);
  }, [ownName, roomKey]);

  useEffect(() => {
    if (!open || !previewEnabled || connected || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const prepare = async () => {
      try {
        if (intent === "audio") {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
          previewStreamRef.current?.getTracks().forEach((track) => track.stop());
          previewStreamRef.current = stream;
          const listed = await navigator.mediaDevices.enumerateDevices();
          setDevices(listed);
          if (!microphoneDevice) setMicrophoneDevice(listed.find((item) => item.kind === "audioinput")?.deviceId ?? "");
          if (!speakerDevice) setSpeakerDevice(listed.find((item) => item.kind === "audiooutput")?.deviceId ?? "");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraDevice ? { deviceId: { exact: cameraDevice } } : true,
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        previewStreamRef.current?.getTracks().forEach((track) => track.stop());
        previewStreamRef.current = stream;
        if (previewRef.current) { previewRef.current.srcObject = stream; await previewRef.current.play().catch(() => undefined); }
        const listed = await navigator.mediaDevices.enumerateDevices();
        setDevices(listed);
        if (!cameraDevice) setCameraDevice(listed.find((item) => item.kind === "videoinput")?.deviceId ?? "");
        if (!microphoneDevice) setMicrophoneDevice(listed.find((item) => item.kind === "audioinput")?.deviceId ?? "");
        if (!speakerDevice) setSpeakerDevice(listed.find((item) => item.kind === "audiooutput")?.deviceId ?? "");
      } catch { setError("Camera preview is unavailable. You can still join with camera off."); }
    };
    void prepare();
    return () => { cancelled = true; previewStreamRef.current?.getTracks().forEach((track) => track.stop()); previewStreamRef.current = null; };
  }, [cameraDevice, connected, intent, microphoneDevice, open, previewEnabled, speakerDevice]);

  useEffect(() => {
    if (moderationCommand?.command !== "mute") return;
    const room = roomRef.current;
    if (room?.localParticipant.isMicrophoneEnabled) void room.localParticipant.setMicrophoneEnabled(false).then(() => refresh(room));
  }, [moderationCommand, refresh]);

  useEffect(() => () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) void room.disconnect();
  }, []);

  async function connectMeeting() {
    if (roomRef.current || connecting) return;
    setConnecting(true);
    setError("");
    try {
      const response = await fetch(`/api/media-token?room=${encodeURIComponent(roomId)}`, {
        headers: { "X-Cinder-Alias": encryptedAlias, "X-Cinder-Capability": httpCapability },
      });
      const payload = await response.json() as MediaCredentials & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Group media is not configured on this server.");

      const keyProvider = new ExternalE2EEKeyProvider();
      const mediaKey = await deriveMediaKey(encodedKey, roomId);
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
        encryption: {
          keyProvider,
          worker: new Worker("/e2ee-worker.js", { type: "module", name: "cinder-media-e2ee" }),
        },
      });

      const update = () => { void refresh(room); };
      room
        .on(RoomEvent.ParticipantConnected, update)
        .on(RoomEvent.ParticipantDisconnected, update)
        .on(RoomEvent.TrackPublished, update)
        .on(RoomEvent.TrackSubscribed, update)
        .on(RoomEvent.TrackUnsubscribed, update)
        .on(RoomEvent.TrackSubscriptionFailed, (_trackSid, participant, reason) => {
          setError(`Could not receive ${participant.identity}'s media${reason ? `: ${String(reason)}` : "."}`);
        })
        .on(RoomEvent.EncryptionError, (_reason, participant) => {
          setError(`Encrypted media from ${participant?.identity ?? "a participant"} could not be decoded.`);
        })
        .on(RoomEvent.LocalTrackPublished, update)
        .on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (publication.source === Track.Source.ScreenShare) onReleasePresent();
          update();
        })
        .on(RoomEvent.TrackMuted, update)
        .on(RoomEvent.TrackUnmuted, update)
        .on(RoomEvent.ActiveSpeakersChanged, update)
        .on(RoomEvent.Disconnected, () => {
          setConnected(false);
          setCameraOn(false);
          setMicrophoneOn(false);
          setScreenOn(false);
          setPeople([]);
          roomRef.current = null;
        });

      await keyProvider.setKey(mediaKey);
      await room.setE2EEEnabled(true);
      await room.connect(payload.serverUrl, payload.participantToken);
      previewStreamRef.current?.getTracks().forEach((track) => track.stop());
      previewStreamRef.current = null;
      roomRef.current = room;
      setConnected(true);
      if (intent === "audio") {
        await room.localParticipant.setMicrophoneEnabled(true, {
          ...(microphoneDevice ? { deviceId: microphoneDevice } : {}),
          echoCancellation: true,
          noiseSuppression,
          autoGainControl: true,
        });
      }
      await refresh(room);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The encrypted media connection failed.");
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    if (!open || connected || connecting) return;
    const task = window.setTimeout(() => void connectMeeting(), 0);
    // Opening is the explicit opt-in to join receive-only. Camera and microphone
    // permissions are still requested only when their controls are enabled.
    return () => window.clearTimeout(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function toggleCamera() {
    const room = roomRef.current;
    if (!room) return;
    if (!cameraOn && people.filter((person) => person.camera).length >= MAX_ACTIVE_CAMERAS) {
      setError(`This room is limited to ${MAX_ACTIVE_CAMERAS} active cameras for predictable performance.`);
      return;
    }
    try { await room.localParticipant.setCameraEnabled(!cameraOn, cameraDevice ? { deviceId: cameraDevice } : undefined); await refresh(room); }
    catch { setError("Camera access was not granted or the camera is unavailable."); }
  }

  async function toggleMicrophone() {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!microphoneOn, {
        ...(microphoneDevice ? { deviceId: microphoneDevice } : {}),
        echoCancellation: true,
        noiseSuppression,
        autoGainControl: true,
      });
      await refresh(room);
    }
    catch { setError("Microphone access was not granted or the microphone is unavailable."); }
  }

  async function toggleScreen() {
    const room = roomRef.current;
    if (!room) return;
    if (screenOn) {
      try { await room.localParticipant.setScreenShareEnabled(false); onReleasePresent(); await refresh(room); }
      catch { setError("The screen share could not be stopped cleanly."); }
      return;
    }
    const permission = await onRequestPresent();
    if (!permission.ok) {
      setError(permission.error || "Another participant is already presenting.");
      return;
    }
    try { await room.localParticipant.setScreenShareEnabled(true, { audio: true }); await refresh(room); }
    catch { onReleasePresent(); setError("Screen access was cancelled or the screen is unavailable."); }
  }

  async function leaveMeeting() {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) await room.disconnect();
    onReleasePresent();
    setConnected(false);
    setPeople([]);
    setCameraOn(false);
    setMicrophoneOn(false);
    setScreenOn(false);
    onCallEnded();
    minimizeMeeting();
  }

  async function switchDevice(kind: MediaDeviceKind, deviceId: string) {
    const room = roomRef.current;
    if (kind === "videoinput") setCameraDevice(deviceId);
    if (kind === "audioinput") setMicrophoneDevice(deviceId);
    if (kind === "audiooutput") setSpeakerDevice(deviceId);
    if (!room) return;
    try {
      await room.switchActiveDevice(kind, deviceId);
      if (kind === "audiooutput") {
        for (const audio of Array.from(document.querySelectorAll(".meeting-card audio"))) {
          const sink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
          await sink.setSinkId?.(deviceId);
        }
      }
    } catch { setError("This browser could not switch that device."); }
  }

  async function openPictureInPicture() {
    const video = document.querySelector<HTMLVideoElement>(".meeting-card .meeting-camera-video:not([muted])")
      ?? document.querySelector<HTMLVideoElement>(".meeting-card .meeting-camera-video");
    try { if (video && document.pictureInPictureEnabled) await video.requestPictureInPicture(); }
    catch { setError("Picture-in-picture is unavailable in this browser."); }
  }

  function startCaptions() {
    const constructors = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Recognition = constructors.SpeechRecognition ?? constructors.webkitSpeechRecognition;
    if (!Recognition) { setError("Live captions are not supported by this browser."); return; }
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal && result[0]?.transcript.trim()) void onMeetingSignal({ type: "caption", value: result[0].transcript.trim().slice(0, 300) });
      }
    };
    recognition.onend = () => { if (recognitionRef.current === recognition) { try { recognition.start(); } catch { setCaptionsOn(false); } } };
    recognitionRef.current = recognition;
    recognition.start();
    setCaptionsOn(true);
  }

  function toggleCaptions() {
    if (captionsOn) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setCaptionsOn(false);
      return;
    }
    setCaptionsConfirmOpen(true);
  }

  if (!open) return null;
  const presenter = people.find((person) => person.screen);
  const raised = new Set<string>();
  for (const signal of meetingSignals.filter((item) => item.type === "hand")) {
    if (signal.value === "up") raised.add(signal.senderId);
    else raised.delete(signal.senderId);
  }
  const reactions = meetingSignals.filter((signal) => signal.type === "reaction").slice(-8);
  const captions = meetingSignals.filter((signal) => signal.type === "caption").slice(-2);
  const questions = meetingSignals.filter((signal) => signal.type === "question").slice(-20);
  const answeredQuestions = new Set(meetingSignals.filter((signal) => signal.type === "question-answer").flatMap((signal) => signal.extra ?? []));
  const polls = meetingSignals.filter((signal) => signal.type === "poll").slice(-5);
  const pollCounts = (pollId: string) => {
    const latest = new Map<string, string>();
    for (const vote of meetingSignals.filter((signal) => signal.type === "vote" && signal.extra?.[0] === pollId)) latest.set(vote.senderId, vote.value);
    return latest;
  };
  const pinned = people.find((person) => person.identity === pinnedId);
  const spotlight = pinned ?? presenter;
  const showSpotlight = layout === "spotlight" || (layout === "auto" && Boolean(spotlight));

  return (
    <section className="meeting-inline-shell" aria-label="Encrypted meeting workspace">
      <div className="meeting-card" role="region" aria-labelledby="meeting-title">
        <header className="meeting-toolbar">
          <div>
            <p className="eyebrow"><span className={`status-dot ${connected ? "" : "offline"}`} /> Encrypted group media</p>
            <h2 id="meeting-title">{presenter ? `${presenter.name} is presenting` : intent === "audio" ? "Encrypted voice call" : "Camera, microphone & screen"}</h2>
          </div>
          <button className="icon-button" aria-label="End call and close media" onClick={() => void leaveMeeting()}><X size={18} /></button>
        </header>

        {!connected ? (
          <div className="meeting-prejoin">
            {previewEnabled && intent !== "audio" ? (
              <div className="prejoin-preview">
                <video ref={previewRef} autoPlay playsInline muted />
                <span><LockKey size={14} /> Preview stays on this device</span>
              </div>
            ) : previewEnabled ? (
              <div className="prejoin-preview audio-preview">
                <Microphone size={34} weight="duotone" />
                <span><LockKey size={14} /> Microphone stays encrypted on this device</span>
              </div>
            ) : <button className="prejoin-preview preview-permission" type="button" onClick={() => setPreviewEnabled(true)}><VideoCamera size={34} weight="duotone" /><strong>Start device preview</strong><span>Requests camera or microphone permission only when selected</span></button>}
            <h3>{intent === "present" ? "Join, then share your screen." : intent === "audio" ? "Join the encrypted voice call." : "Join the encrypted video room."}</h3>
            <p>{intent === "audio" ? "Your microphone turns on when you join. Camera stays off unless you enable it later." : "Cameras and microphones remain off until you enable them. Screen, camera, and microphone tracks can run at the same time."}</p>
            {previewEnabled && <div className="device-grid">
              {intent !== "audio" && <label>Camera<select value={cameraDevice} onChange={(event) => void switchDevice("videoinput", event.target.value)}>{devices.filter((item) => item.kind === "videoinput").map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `Camera ${index + 1}`}</option>)}</select></label>}
              <label>Microphone<select value={microphoneDevice} onChange={(event) => void switchDevice("audioinput", event.target.value)}>{devices.filter((item) => item.kind === "audioinput").map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `Microphone ${index + 1}`}</option>)}</select></label>
              <label>Speaker<select value={speakerDevice} onChange={(event) => void switchDevice("audiooutput", event.target.value)}>{devices.filter((item) => item.kind === "audiooutput").map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `Speaker ${index + 1}`}</option>)}</select></label>
            </div>}
            {error && <div className="meeting-error" role="alert">{error}</div>}
            <button className="primary-button" disabled={connecting} onClick={connectMeeting}>
              <ShieldCheck size={18} weight="fill" /> {connecting ? "Connecting…" : intent === "audio" ? "Join encrypted call" : "Join encrypted media"}
            </button>
            {error && <button className="soft-button" onClick={onFallbackPresent}><MonitorArrowUp size={17} /> Use tunnel presentation</button>}
            <p className="privacy-note">A Cloudflare browser invitation can open this room, but camera media also requires the configured public LiveKit/TURN endpoint.</p>
          </div>
        ) : (
          <>
            <div className={`meeting-stage ${showSpotlight ? "has-presentation" : ""} layout-${layout}`}>
              {spotlight && (spotlight.screen || spotlight.camera) && (
                <div className="meeting-presentation">
                  <VideoTrackView track={(spotlight.screen ?? spotlight.camera)!} muted={spotlight.isLocal} className="meeting-screen-video" />
                  <div className="meeting-tile-label"><LockKey size={14} /> {spotlight.name} · {spotlight.screen ? "screen" : "pinned"}</div>
                </div>
              )}
              <div className="meeting-grid">
                {people.map((person) => (
                  <article className={`meeting-tile ${person.speaking ? "speaking" : ""} ${person.isLocal && people.length > 1 ? "self-view" : ""}`} key={person.identity}>
                    {person.camera ? (
                      <VideoTrackView track={person.camera} muted={person.isLocal} className="meeting-camera-video" />
                    ) : (
                      <div className="meeting-camera-off"><CameraSlash size={25} /><span>Camera off</span></div>
                    )}
                    <div className="meeting-tile-label">
                      <span>{person.name}{person.isLocal ? " · you" : ""} {raised.has(person.identity) ? "✋" : ""}</span>
                      <span className={`quality-dot quality-${person.quality}`} title={`Network: ${person.quality}`} />
                      {!person.microphone && <MicrophoneSlash size={14} />}
                    </div>
                    <button className="tile-pin" aria-label={`Pin ${person.name}`} onClick={() => setPinnedId(pinnedId === person.identity ? "" : person.identity)}><PushPin size={15} weight={pinnedId === person.identity ? "fill" : "regular"} /></button>
                    {!person.isLocal && person.microphone && <AudioTrackSink track={person.microphone} />}
                  </article>
                ))}
              </div>
              <div className="reaction-float" aria-live="polite">{reactions.map((reaction) => <span key={reaction.id}>{reaction.value}</span>)}</div>
              {captions.length > 0 && <div className="caption-strip">{captions.map((caption) => <p key={caption.id}><strong>{caption.sender}:</strong> {caption.value}</p>)}</div>}
            </div>
            {error && <div className="meeting-error compact" role="alert">{error}</div>}
            <footer className="meeting-controls" aria-label="Meeting controls">
              <button className={`meeting-control ${microphoneOn ? "active" : ""}`} aria-pressed={microphoneOn} onClick={toggleMicrophone} aria-label={microphoneOn ? "Mute microphone" : "Turn on microphone"}>
                {microphoneOn ? <Microphone size={20} weight="fill" /> : <MicrophoneSlash size={20} />}
                <span>{microphoneOn ? "Mute" : "Mic"}</span>
              </button>
              <button className={`meeting-control ${cameraOn ? "active" : ""}`} aria-pressed={cameraOn} onClick={toggleCamera} aria-label={cameraOn ? "Turn off camera" : "Turn on camera"}>
                {cameraOn ? <Camera size={20} weight="fill" /> : <CameraSlash size={20} />}
                <span>{cameraOn ? "Stop video" : "Camera"}</span>
              </button>
              <button className={`meeting-control ${screenOn ? "active" : ""}`} aria-pressed={screenOn} onClick={toggleScreen} aria-label={screenOn ? "Stop sharing screen" : "Share screen"}>
                {screenOn ? <StopCircle size={20} weight="fill" /> : <MonitorArrowUp size={20} />}
                <span>{screenOn ? "Stop share" : "Present"}</span>
              </button>
              <button className={`meeting-control ${raised.has(socketId) ? "active" : ""}`} aria-pressed={raised.has(socketId)} onClick={() => void onMeetingSignal({ type: "hand", value: raised.has(socketId) ? "down" : "up" })} aria-label={raised.has(socketId) ? "Lower hand" : "Raise hand"}><HandPalm size={20} /><span>Hand</span></button>
              <button className="meeting-control" aria-expanded={drawer === "activities"} onClick={() => setDrawer(drawer === "activities" ? null : "activities")} aria-label="Reactions and activities"><Smiley size={20} /><span>Activities</span></button>
              <button className={`meeting-control ${captionsOn ? "active" : ""}`} aria-pressed={captionsOn} onClick={toggleCaptions} aria-label="Toggle live captions"><ClosedCaptioning size={20} /><span>Captions</span></button>
              <button className="meeting-control" aria-expanded={drawer === "people"} onClick={() => setDrawer(drawer === "people" ? null : "people")} aria-label="Participants"><SidebarSimple size={20} /><span>People</span></button>
              <button className="meeting-control" aria-expanded={drawer === "settings"} onClick={() => setDrawer(drawer === "settings" ? null : "settings")} aria-label="Meeting settings"><Gear size={20} /><span>Settings</span></button>
              <button className="meeting-control leave" onClick={leaveMeeting} aria-label="Leave video meeting">
                <PhoneDisconnect size={20} weight="fill" /><span>Leave call</span>
              </button>
            </footer>
            {drawer && (
              <aside className="meeting-drawer" aria-label={`${drawer} panel`}>
                <header><strong>{drawer === "people" ? "People" : drawer === "activities" ? "Activities" : "Meeting settings"}</strong><button className="icon-button" aria-label="Close panel" onClick={() => setDrawer(null)}><X size={17} /></button></header>
                {drawer === "people" && <div className="meeting-drawer-body">
                  {isHost && <button className={`soft-button ${admissionLocked ? "live-button" : ""}`} onClick={() => onAdmissionLock(!admissionLocked)}><LockKey size={16} /> {admissionLocked ? "Unlock room" : "Lock new joins"}</button>}
                  {pendingPeople.map((person) => <div className="participant-row" key={person.id}><span>{person.name} · waiting</span><div><button onClick={() => onAdmissionDecision(person.id, true)}>Admit</button><button onClick={() => onAdmissionDecision(person.id, false)}>Deny</button></div></div>)}
                  {participants.map((person) => <div className="participant-row" key={person.id}><span>{person.name}{person.id === socketId ? " · you" : ""}</span>{isHost && person.id !== socketId && <div><button aria-label={`Mute ${person.name}`} onClick={() => onModerate(person.id, "mute")}><MicrophoneSlash size={15} /></button><button aria-label={`Remove ${person.name}`} onClick={() => onModerate(person.id, "remove")}><UserMinus size={15} /></button></div>}</div>)}
                </div>}
                {drawer === "activities" && <div className="meeting-drawer-body activities-panel">
                  <div className="reaction-row">{[["👍", "thumbs up"], ["❤️", "heart"], ["😂", "laughter"], ["🎉", "celebration"], ["👏", "applause"], ["🤔", "thinking"]].map(([emoji, label]) => <button key={emoji} aria-label={`React with ${label}`} onClick={() => void onMeetingSignal({ type: "reaction", value: emoji })}>{emoji}</button>)}</div>
                  <label><Question size={16} /> Q&amp;A<input value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} placeholder="Ask an encrypted question" /><button disabled={!questionDraft.trim()} onClick={() => { void onMeetingSignal({ type: "question", value: questionDraft.trim().slice(0, 240) }); setQuestionDraft(""); }}>Ask</button></label>
                  {questions.map((question) => <div className="activity-card" key={question.id}><strong>{question.sender}{answeredQuestions.has(question.id) ? " · answered" : ""}</strong><span>{question.value}</span>{isHost && !answeredQuestions.has(question.id) && <button onClick={() => void onMeetingSignal({ type: "question-answer", value: "answered", extra: [question.id] })}>Mark answered</button>}</div>)}
                  {isHost && <label><ChartBar size={16} /> Quick poll<input value={pollDraft} onChange={(event) => setPollDraft(event.target.value)} placeholder="Yes / No question" /><button disabled={!pollDraft.trim()} onClick={() => { void onMeetingSignal({ type: "poll", value: pollDraft.trim().slice(0, 180), extra: ["Yes", "No"] }); setPollDraft(""); }}>Launch</button></label>}
                  {polls.map((poll) => { const counts = pollCounts(poll.id); return <div className="activity-card" key={poll.id}><strong>{poll.value}</strong><div className="poll-options">{(poll.extra ?? ["Yes", "No"]).map((option) => <button key={option} onClick={() => void onMeetingSignal({ type: "vote", value: option, extra: [poll.id] })}>{option} · {[...counts.values()].filter((value) => value === option).length}</button>)}</div></div>; })}
                </div>}
                {drawer === "settings" && <div className="meeting-drawer-body settings-panel">
                  <label>Layout<select value={layout} onChange={(event) => setLayout(event.target.value as typeof layout)}><option value="auto">Auto</option><option value="grid">Grid</option><option value="spotlight">Spotlight</option></select></label>
                  <label>Camera<select value={cameraDevice} onChange={(event) => void switchDevice("videoinput", event.target.value)}>{devices.filter((item) => item.kind === "videoinput").map((item) => <option key={item.deviceId} value={item.deviceId}>{item.label}</option>)}</select></label>
                  <label>Microphone<select value={microphoneDevice} onChange={(event) => void switchDevice("audioinput", event.target.value)}>{devices.filter((item) => item.kind === "audioinput").map((item) => <option key={item.deviceId} value={item.deviceId}>{item.label}</option>)}</select></label>
                  <label>Speaker<select value={speakerDevice} onChange={(event) => void switchDevice("audiooutput", event.target.value)}>{devices.filter((item) => item.kind === "audiooutput").map((item) => <option key={item.deviceId} value={item.deviceId}>{item.label}</option>)}</select></label>
                  <label className="toggle-row"><input type="checkbox" checked={noiseSuppression} onChange={(event) => setNoiseSuppression(event.target.checked)} /> Browser noise suppression</label>
                  <button className="soft-button" onClick={openPictureInPicture}><PictureInPicture size={17} /> Picture in picture</button>
                  <p className="privacy-note">Noise suppression uses the browser&apos;s free WebRTC processing. Captions may use your browser vendor&apos;s speech service.</p>
                </div>}
              </aside>
            )}
          </>
        )}
      </div>

      {captionsConfirmOpen && (
        <div className="modal-backdrop confirm-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setCaptionsConfirmOpen(false)}>
          <section className="modal-card confirm-card" tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="captions-confirm-title" aria-describedby="captions-confirm-message">
            <p className="eyebrow">Live captions</p>
            <h2 id="captions-confirm-title">Enable captions?</h2>
            <p id="captions-confirm-message">Browser captions may send microphone audio to your browser vendor&apos;s speech service. Caption text is encrypted by Cinder, but recognition may not be local.</p>
            <div className="confirm-actions">
              <button className="soft-button" type="button" onClick={() => setCaptionsConfirmOpen(false)}>Cancel</button>
              <button className="primary-button" type="button" onClick={() => { setCaptionsConfirmOpen(false); startCaptions(); }}>Enable captions</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
