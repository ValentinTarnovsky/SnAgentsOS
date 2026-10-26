/**
 * The read-only Chat of a shared console (app 2.4.0, item 8, S5). Its model
 * moved to src/renderer/components/chat/chatModel.ts (app 2.7.0), shared with
 * the desktop console chat, and keeps its labels under `shareGuest.chat.*`;
 * this file keeps the import path. Links are only offered, always through
 * the guest's ConfirmLinkDialog, never opened from here.
 */
export * from '@/components/chat/chatModel'
