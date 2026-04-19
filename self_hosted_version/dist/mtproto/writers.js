import { writeTlString, writeTlBytes, writeIntVector } from './tlHelpers.js';
import { getMessageStore } from '../database/messageStore.js';
import { getActiveSession } from './parsers.js';
const messageStore = getMessageStore();
/**
 * Check if a viewer is allowed to see a particular privacy-protected field of a target user.
 * Returns true if the field should be VISIBLE to the viewer.
 */
export function isFieldVisibleByPrivacy(targetUserId, viewerId, privacyKey) {
    if (targetUserId === viewerId)
        return true; // always see own data
    const rules = messageStore.getPrivacyRules(targetUserId, privacyKey);
    if (rules.length === 0)
        return true; // default: visible
    let baseAllowed = true; // default if no base rule found
    for (const rule of rules) {
        switch (rule.ruleType) {
            case 'allowAll':
                baseAllowed = true;
                break;
            case 'disallowAll':
                baseAllowed = false;
                break;
            case 'allowContacts':
                // For now treat contacts as allowed (we don't have full contact graph yet)
                baseAllowed = true;
                break;
            case 'disallowContacts':
                baseAllowed = false;
                break;
            case 'allowCloseFriends':
                baseAllowed = false; // viewer is not a close friend by default
                break;
            case 'allowPremium':
                // Check if viewer is premium
                {
                    const viewerUser = messageStore.getUserById(viewerId);
                    if (viewerUser?.premium)
                        return true;
                }
                break;
            case 'allowUsers':
                if (rule.value.includes(viewerId))
                    return true;
                break;
            case 'disallowUsers':
                if (rule.value.includes(viewerId))
                    return false;
                break;
            case 'allowChatParticipants':
                // skip for now — would need chat membership check
                break;
            case 'disallowChatParticipants':
                break;
            case 'allowBots':
                break;
            case 'disallowBots':
                break;
        }
    }
    return baseAllowed;
}
/**
 * Returns true when talking to the web client fork (Layer >= 200 or unknown).
 * Web client uses older constructor IDs despite higher layer number.
 * GramJS npm (Layer 198) uses newer constructor IDs matching official Telegram.
 */
function isWebClient() {
    const s = getActiveSession();
    return !s?.layer || s.layer >= 200;
}
// ========== Peer writers ==========
export function writePeerByKey(w, peerKey) {
    const [type, rawId] = peerKey.split(':');
    const id = BigInt(rawId || '0');
    switch (type) {
        case 'user':
            w.writeInt(0x59511722); // peerUser
            w.writeLong(id);
            return;
        case 'chat':
            w.writeInt(0x36c6019a); // peerChat
            w.writeLong(id);
            return;
        case 'channel':
            w.writeInt(0xa2a5371e); // peerChannel
            w.writeLong(id);
            return;
        default:
            w.writeInt(0x59511722);
            w.writeLong(id);
    }
}
// ========== Message writer ==========
export function writeMessageFromFixture(w, message) {
    // Dispatch to service message writer if action is present
    if (message.action) {
        writeServiceMessageFromFixture(w, message);
        return;
    }
    // message#3ae56482 flags:# ... flags2:# id:int from_id:flags.8?Peer from_boosts_applied:flags.29?int
    // from_rank:flags2.12?string peer_id:Peer saved_peer_id:flags.28?Peer ... date:int message:string media:flags.9?MessageMedia ...
    w.writeInt(0x3ae56482);
    let flags = 0;
    if (message.out)
        flags |= (1 << 1);
    if (message.fwdFromPeerKey || message.fwdFromName)
        flags |= (1 << 2); // fwd_from
    if (message.replyToMsgId)
        flags |= (1 << 3);
    if (message.fromPeerKey)
        flags |= (1 << 8);
    if (message.post)
        flags |= (1 << 14);
    if (message.editDate)
        flags |= (1 << 15);
    if (message.savedPeerKey)
        flags |= (1 << 28);
    // Lookup media if present
    let media;
    if (message.mediaId) {
        media = messageStore.getMedia(message.mediaId);
        if (media)
            flags |= (1 << 9);
    }
    if (message.reactions && message.reactions.length > 0)
        flags |= (1 << 20);
    w.writeInt(flags);
    w.writeInt(0); // flags2
    w.writeInt(message.id);
    if (message.fromPeerKey) {
        writePeerByKey(w, message.fromPeerKey);
    }
    writePeerByKey(w, message.peerKey);
    if (message.savedPeerKey) {
        writePeerByKey(w, message.savedPeerKey);
    }
    if (message.fwdFromPeerKey || message.fwdFromName) {
        // messageFwdHeader#4e4df4bb flags:# imported:flags.7?true saved_out:flags.11?true
        // from_id:flags.0?Peer from_name:flags.5?string date:int ...
        // from_id and from_name are mutually exclusive: from_name is only used when sender hides identity
        w.writeInt(0x4e4df4bb);
        let fwdFlags = 0;
        if (message.fwdFromPeerKey)
            fwdFlags |= (1 << 0);
        if (message.fwdFromName && !message.fwdFromPeerKey)
            fwdFlags |= (1 << 5);
        w.writeInt(fwdFlags);
        if (message.fwdFromPeerKey) {
            writePeerByKey(w, message.fwdFromPeerKey);
        }
        if (message.fwdFromName && !message.fwdFromPeerKey) {
            writeTlString(w, message.fwdFromName);
        }
        w.writeInt(message.fwdDate || message.date);
    }
    if (message.replyToMsgId) {
        // messageReplyHeader#6917560b flags:# reply_to_scheduled:flags.2?true forum_topic:flags.3?true quote:flags.9?true
        // reply_to_msg_id:flags.4?int reply_to_peer_id:flags.0?Peer reply_from:flags.5?MessageFwdHeader
        // reply_media:flags.8?MessageMedia reply_to_top_id:flags.1?int quote_text:flags.6?string
        // quote_entities:flags.7?Vector<MessageEntity> quote_offset:flags.10?int
        w.writeInt(0x6917560b); // messageReplyHeader constructor
        let replyFlags = (1 << 4); // reply_to_msg_id
        if (message.quoteText) {
            replyFlags |= (1 << 9); // quote = true
            replyFlags |= (1 << 6); // quote_text present
        }
        if (message.quoteOffset !== undefined && message.quoteOffset > 0) {
            replyFlags |= (1 << 10); // quote_offset present
        }
        w.writeInt(replyFlags);
        w.writeInt(message.replyToMsgId);
        if (message.quoteText) {
            writeTlString(w, message.quoteText);
        }
        if (message.quoteOffset !== undefined && message.quoteOffset > 0) {
            w.writeInt(message.quoteOffset);
        }
    }
    w.writeInt(message.date);
    writeTlString(w, message.text);
    if (media) {
        writeMessageMedia(w, media);
    }
    if (message.editDate) {
        w.writeInt(message.editDate);
    }
    if (message.reactions && message.reactions.length > 0) {
        writeMessageReactions(w, message.reactions);
    }
}
function writeMessageReactions(w, reactions) {
    // messageReactions#a339f0b flags:# min:flags.0?true can_see_list:flags.2?true reactions_as_tags:flags.3?true
    //   results:Vector<ReactionCount> recent_reactions:flags.1?Vector<MessagePeerReaction> top_reactors:flags.4?Vector<MessageReactor>
    w.writeInt(0x0a339f0b);
    const mrFlags = (1 << 2); // can_see_list=true
    w.writeInt(mrFlags);
    // results: Vector<ReactionCount>
    w.writeInt(0x1cb5c415);
    w.writeInt(reactions.length);
    for (const r of reactions) {
        // reactionCount#a3d1cb80 flags:# chosen_order:flags.0?int reaction:Reaction count:int
        w.writeInt(0xa3d1cb80);
        const rcFlags = r.chosenOrder !== undefined ? (1 << 0) : 0;
        w.writeInt(rcFlags);
        if (r.chosenOrder !== undefined) {
            w.writeInt(r.chosenOrder);
        }
        // reactionEmoji#1b2286b8 emoticon:string
        w.writeInt(0x1b2286b8);
        writeTlString(w, r.emoticon);
        w.writeInt(r.count);
    }
}
/**
 * Write messageService#2b085862 (old) / messageService#d3d28540 (new layer)
 * messageService#d3d28540 flags:# out:flags.1?true mentioned:flags.4?true media_unread:flags.5?true
 *   reactions_are_possible:flags.10?true silent:flags.13?true post:flags.14?true legacy:flags.19?true
 *   id:int from_id:flags.8?Peer peer_id:Peer reply_to:flags.3?MessageReplyHeader
 *   date:int action:MessageAction reactions:flags.20?MessageReactions ttl_period:flags.25?int
 */
function writeServiceMessageFromFixture(w, message) {
    // Web client: messageService#7a800e0a, GramJS npm: messageService#d3d28540
    w.writeInt(isWebClient() ? 0x7a800e0a : 0xd3d28540);
    let flags = 0;
    if (message.out)
        flags |= (1 << 1);
    if (message.fromPeerKey)
        flags |= (1 << 8);
    w.writeInt(flags);
    w.writeInt(message.id);
    if (message.fromPeerKey) {
        writePeerByKey(w, message.fromPeerKey);
    }
    writePeerByKey(w, message.peerKey);
    w.writeInt(message.date);
    // MessageAction
    writeMessageAction(w, message.action);
}
function writeMessageAction(w, action) {
    switch (action.type) {
        case 'chatCreate': {
            // messageActionChatCreate#bd47cbad title:string users:Vector<long>
            w.writeInt(0xbd47cbad);
            writeTlString(w, action.title);
            w.writeInt(0x1cb5c415); // vector
            const userIds = action.userIds || [];
            w.writeInt(userIds.length);
            for (const uid of userIds) {
                w.writeLong(BigInt(uid));
            }
            break;
        }
        case 'channelCreate': {
            // messageActionChannelCreate#95d2ac92 title:string
            w.writeInt(0x95d2ac92);
            writeTlString(w, action.title);
            break;
        }
        case 'chatEditPhoto': {
            // messageActionChatEditPhoto#7fcb13a8 photo:Photo
            w.writeInt(0x7fcb13a8);
            if (action.photoId) {
                const media = messageStore.getMedia(action.photoId);
                if (media) {
                    writePhotoObject(w, media);
                    break;
                }
            }
            // photoEmpty#2331b22d id:long
            w.writeInt(0x2331b22d);
            w.writeLong(BigInt(0));
            break;
        }
        case 'chatDeleteUser': {
            // messageActionChatDeleteUser#a43f30cc user_id:long
            w.writeInt(0xa43f30cc);
            w.writeLong(BigInt(action.userId || 0));
            break;
        }
        case 'phoneCall': {
            // messageActionPhoneCall#80e11a7f flags:# video:flags.2?true call_id:long reason:flags.0?PhoneCallDiscardReason duration:flags.1?int
            w.writeInt(0x80e11a7f);
            let mflags = 0;
            if (action.reason)
                mflags |= (1 << 0);
            if (action.duration !== undefined)
                mflags |= (1 << 1);
            if (action.isVideo)
                mflags |= (1 << 2);
            w.writeInt(mflags);
            w.writeLong(BigInt(action.callId || '0'));
            if (action.reason) {
                switch (action.reason) {
                    case 'missed':
                        w.writeInt(0x85e42301);
                        break;
                    case 'disconnect':
                        w.writeInt(0xe095c1a0);
                        break;
                    case 'hangup':
                        w.writeInt(0x57adc690);
                        break;
                    case 'busy':
                        w.writeInt(0xfabdef90);
                        break;
                    default:
                        w.writeInt(0x57adc690);
                        break;
                }
            }
            if (action.duration !== undefined) {
                w.writeInt(action.duration);
            }
            break;
        }
    }
}
// ========== Media TL writers ==========
function writeMessageMedia(w, media) {
    if (media.type === 'photo') {
        writeMessageMediaPhoto(w, media);
    }
    else {
        writeMessageMediaDocument(w, media);
    }
}
export function writePhotoObject(w, media) {
    // Photo#fb197a65 flags:# id:long access_hash:long file_reference:bytes date:int sizes:Vector<PhotoSize> video_sizes:flags.1?Vector<VideoSize> dc_id:int
    w.writeInt(0xfb197a65);
    w.writeInt(0); // photo flags
    const publicPhotoId = (BigInt(media.createdAt) << 20n) | BigInt(media.id);
    w.writeLong(publicPhotoId); // id
    w.writeLong(publicPhotoId * 997n); // access_hash
    writeTlBytes(w, Buffer.alloc(0)); // file_reference
    w.writeInt(media.createdAt); // date
    const photoW = media.width || 800;
    const photoH = media.height || 800;
    const scale = Math.min(1, 320 / Math.max(photoW, photoH));
    const mW = Math.round(photoW * scale);
    const mH = Math.round(photoH * scale);
    w.writeInt(0x1cb5c415); // vector
    w.writeInt(2); // two sizes: "m" (medium) and "x" (full)
    w.writeInt(0x75c78e60);
    writeTlString(w, 'm');
    w.writeInt(mW);
    w.writeInt(mH);
    w.writeInt(media.fileSize);
    w.writeInt(0x75c78e60);
    writeTlString(w, 'x');
    w.writeInt(photoW);
    w.writeInt(photoH);
    w.writeInt(media.fileSize);
    w.writeInt(1); // dc_id
}
function writeMessageMediaPhoto(w, media) {
    // messageMediaPhoto#695150d7 flags:# photo:flags.0?Photo ...
    w.writeInt(0x695150d7);
    const flags = 1; // bit 0 = photo present
    w.writeInt(flags);
    writePhotoObject(w, media);
}
function writeMessageMediaDocument(w, media) {
    // messageMediaDocument#52d8ccd9 flags:# nopremium:flags.3?true spoiler:flags.4?true video:flags.6?true round:flags.7?true voice:flags.8?true document:flags.0?Document ...
    w.writeInt(0x52d8ccd9);
    let mediaDocFlags = 1; // bit 0 = document present
    if (media.isVoice)
        mediaDocFlags |= (1 << 8); // voice
    w.writeInt(mediaDocFlags);
    // Document#8fd4c4d8 flags:# id:long access_hash:long file_reference:bytes date:int mime_type:string size:long thumbs:flags.0?Vector<PhotoSize> video_thumbs:flags.1?Vector<VideoSize> dc_id:int attributes:Vector<DocumentAttribute>
    w.writeInt(0x8fd4c4d8);
    let docFlags = 0;
    // No thumbs for simplicity
    w.writeInt(docFlags);
    w.writeLong(BigInt(media.id)); // id
    w.writeLong(BigInt(media.id * 1000)); // access_hash
    writeTlBytes(w, Buffer.alloc(0)); // file_reference
    w.writeInt(media.createdAt); // date
    writeTlString(w, media.mimeType); // mime_type
    w.writeLong(BigInt(media.fileSize)); // size (long)
    // no thumbs (flag 0 not set)
    // no video_thumbs (flag 1 not set)
    w.writeInt(1); // dc_id
    // attributes: Vector<DocumentAttribute>
    const attrs = [];
    if (media.isVoice || (media.duration !== undefined && media.mimeType?.startsWith('audio/'))) {
        attrs.push(() => {
            // documentAttributeAudio#9852f9c6 flags:# voice:flags.10?true duration:int title:flags.0?string performer:flags.1?string waveform:flags.2?bytes
            w.writeInt(0x9852f9c6);
            let audioFlags = 0;
            if (media.isVoice)
                audioFlags |= (1 << 10); // voice
            if (media.waveform)
                audioFlags |= (1 << 2); // waveform
            w.writeInt(audioFlags);
            w.writeInt(media.duration || 0);
            // title (flag 0) — not set for voice
            // performer (flag 1) — not set for voice
            if (media.waveform) {
                writeTlBytes(w, media.waveform);
            }
        });
    }
    if (media.width && media.height) {
        attrs.push(() => {
            // documentAttributeImageSize#6c37c15c w:int h:int
            w.writeInt(0x6c37c15c);
            w.writeInt(media.width);
            w.writeInt(media.height);
        });
    }
    if (media.fileName) {
        attrs.push(() => {
            // documentAttributeFilename#15590068 file_name:string
            w.writeInt(0x15590068);
            writeTlString(w, media.fileName);
        });
    }
    w.writeInt(0x1cb5c415); // vector
    w.writeInt(attrs.length);
    for (const writeAttr of attrs) {
        writeAttr();
    }
}
// ========== User writer ==========
export function writeUserFromFixture(w, user, viewerId) {
    const photoMedia = user.photoId ? messageStore.getMedia(user.photoId) : undefined;
    const numericUserId = Number(user.id);
    const isSelfView = viewerId !== undefined && viewerId === numericUserId;
    const vid = viewerId ?? numericUserId; // if no viewerId, assume self
    // Privacy checks for non-self views
    const phoneVisible = user.self || isSelfView || !viewerId || isFieldVisibleByPrivacy(numericUserId, vid, 'phoneNumber');
    const statusVisible = user.self || isSelfView || !viewerId || isFieldVisibleByPrivacy(numericUserId, vid, 'statusTimestamp');
    const photoVisible = user.self || isSelfView || !viewerId || isFieldVisibleByPrivacy(numericUserId, vid, 'profilePhoto');
    const showPhone = phoneVisible && user.phone;
    const showPhoto = photoVisible && photoMedia;
    // --- flags ---
    let flags = 0;
    if (user.accessHash)
        flags |= (1 << 0); // access_hash
    if (user.firstName)
        flags |= (1 << 1); // first_name
    if (user.lastName)
        flags |= (1 << 2); // last_name
    if (user.username)
        flags |= (1 << 3); // username
    if (showPhone)
        flags |= (1 << 4); // phone
    if (showPhoto)
        flags |= (1 << 5); // photo
    flags |= (1 << 6); // status (always)
    if (user.bot)
        flags |= (1 << 14); // bot
    if (user.bot)
        flags |= (1 << 15); // bot_nochats (default false, bit always present for bots)
    if (user.verified)
        flags |= (1 << 17); // verified
    if (user.restricted)
        flags |= (1 << 18); // restricted
    if (user.scam)
        flags |= (1 << 24); // scam
    if (user.fake)
        flags |= (1 << 26); // fake
    if (user.self)
        flags |= (1 << 10); // self
    if (user.premium)
        flags |= (1 << 28); // premium
    if (user.contact)
        flags |= (1 << 11); // contact
    if (user.bot && user.botInfoVersion)
        flags |= (1 << 14); // bot (already set above)
    if (user.botInlinePlaceholder)
        flags |= (1 << 19); // bot_inline_placeholder
    if (user.langCode)
        flags |= (1 << 22); // lang_code
    if (user.emojiStatusDocumentId)
        flags |= (1 << 30); // emoji_status
    // color: encoded in flags2
    // restrictionReason: would be flags bit 18 + vector, skip for now
    // --- flags2 ---
    let flags2 = (1 << 4); // stories_unavailable (default)
    if (user.colorId !== undefined)
        flags2 |= (1 << 8); // color
    if (user.profileColorId !== undefined)
        flags2 |= (1 << 9); // profile_color
    if (user.botActiveUsers !== undefined)
        flags2 |= (1 << 11); // bot_active_users
    if (user.contactRequirePremium)
        flags2 |= (1 << 10); // contact_require_premium
    // --- write constructor ---
    w.writeInt(isWebClient() ? 0x31774388 : 0x4b46c37e);
    w.writeInt(flags);
    w.writeInt(flags2);
    w.writeLong(BigInt(user.id));
    // access_hash
    if (user.accessHash) {
        w.writeLong(BigInt(user.accessHash));
    }
    // first_name
    if (user.firstName) {
        writeTlString(w, user.firstName);
    }
    // last_name
    if (user.lastName) {
        writeTlString(w, user.lastName);
    }
    // username
    if (user.username) {
        writeTlString(w, user.username);
    }
    // phone
    if (showPhone) {
        writeTlString(w, user.phone);
    }
    // photo
    if (showPhoto) {
        // userProfilePhoto#82d1f706 flags:# has_video:flags.0?true personal:flags.2?true photo_id:long stripped_thumb:flags.1?bytes dc_id:int
        w.writeInt(0x82d1f706);
        w.writeInt(0);
        const publicPhotoId = (BigInt(photoMedia.createdAt) << 20n) | BigInt(photoMedia.id);
        w.writeLong(publicPhotoId);
        w.writeInt(2);
    }
    // status
    if (user.self || isSelfView || messageStore.isUserOnline(numericUserId)) {
        // userStatusOnline#edb93949 expires:int
        w.writeInt(0xedb93949);
        w.writeInt(Math.floor(Date.now() / 1000) + 300);
    }
    else if (!statusVisible) {
        // Privacy hides exact last seen — show approximate status
        const lastSeen = messageStore.getUserLastSeen(numericUserId);
        const now = Math.floor(Date.now() / 1000);
        if (lastSeen && (now - lastSeen) < 3 * 86400) {
            // userStatusRecently#7b197dc8 flags:# by_me:flags.0?true
            w.writeInt(0x7b197dc8);
            w.writeInt(0); // flags (no by_me)
        }
        else if (lastSeen && (now - lastSeen) < 7 * 86400) {
            // userStatusLastWeek#541a1d1a flags:# by_me:flags.0?true
            w.writeInt(0x541a1d1a);
            w.writeInt(0);
        }
        else if (lastSeen && (now - lastSeen) < 30 * 86400) {
            // userStatusLastMonth#65899777 flags:# by_me:flags.0?true
            w.writeInt(0x65899777);
            w.writeInt(0);
        }
        else {
            // userStatusRecently — better default than "long time ago" for active users
            w.writeInt(0x7b197dc8);
            w.writeInt(0);
        }
    }
    else {
        const lastSeen = messageStore.getUserLastSeen(numericUserId);
        if (lastSeen) {
            // userStatusOffline#008c703f was_online:int
            w.writeInt(0x008c703f);
            w.writeInt(lastSeen);
        }
        else {
            // userStatusEmpty#09d05049
            w.writeInt(0x09d05049);
        }
    }
    // bot_info_version (flags.14 && bot)
    if (user.bot && user.botInfoVersion) {
        w.writeInt(user.botInfoVersion);
    }
    // restriction_reason: Vector<RestrictionReason> — skip (not set)
    // bot_inline_placeholder
    if (user.botInlinePlaceholder) {
        writeTlString(w, user.botInlinePlaceholder);
    }
    // lang_code
    if (user.langCode) {
        writeTlString(w, user.langCode);
    }
    // emoji_status
    if (user.emojiStatusDocumentId) {
        if (user.emojiStatusUntil) {
            // emojiStatusUntil#fa30a8c7 document_id:long until:int
            w.writeInt(0xfa30a8c7);
            w.writeLong(BigInt(user.emojiStatusDocumentId));
            w.writeInt(user.emojiStatusUntil);
        }
        else {
            // emojiStatus#929b619d document_id:long
            w.writeInt(0x929b619d);
            w.writeLong(BigInt(user.emojiStatusDocumentId));
        }
    }
    // usernames: Vector<Username> — skip (single username via flag 3)
    // stories_max_id: skip
    // color (flags2.8)
    if (user.colorId !== undefined) {
        // peerColor#b54b5acf flags:# color:flags.0?int background_emoji_id:flags.1?long
        w.writeInt(0xb54b5acf);
        let colorFlags = (1 << 0); // color present
        if (user.colorBackgroundEmojiId)
            colorFlags |= (1 << 1);
        w.writeInt(colorFlags);
        w.writeInt(user.colorId);
        if (user.colorBackgroundEmojiId) {
            w.writeLong(BigInt(user.colorBackgroundEmojiId));
        }
    }
    // profile_color (flags2.9)
    if (user.profileColorId !== undefined) {
        // peerColor#b54b5acf
        w.writeInt(0xb54b5acf);
        let pcFlags = (1 << 0);
        if (user.profileColorBackgroundEmojiId)
            pcFlags |= (1 << 1);
        w.writeInt(pcFlags);
        w.writeInt(user.profileColorId);
        if (user.profileColorBackgroundEmojiId) {
            w.writeLong(BigInt(user.profileColorBackgroundEmojiId));
        }
    }
    // bot_active_users (flags2.11)
    if (user.botActiveUsers !== undefined) {
        w.writeInt(user.botActiveUsers);
    }
}
export function writeFallbackUserFromId(w, userId) {
    writeUserFromFixture(w, {
        id: userId,
        accessHash: '0',
        firstName: 'User',
    });
}
// ========== Chat / Channel writer ==========
export function writeChatFromFixture(w, chat) {
    if (chat.className === 'Channel') {
        writeChannelFromFixture(w, chat);
    }
}
/** Write a basic group chat from StoredChat */
export function writeChatFromDb(w, chat, selfId) {
    const messageStore = getMessageStore();
    if (chat.type === 'channel' || chat.type === 'supergroup') {
        // channel#1c32b11c
        let flags = 0;
        if (chat.creatorUserId === selfId)
            flags |= (1 << 0); // creator
        if (chat.isBroadcast)
            flags |= (1 << 5); // broadcast
        if (chat.isMegagroup)
            flags |= (1 << 8); // megagroup
        flags |= (1 << 13); // access_hash present
        w.writeInt(0x1c32b11c);
        w.writeInt(flags);
        w.writeInt(0); // flags2
        w.writeLong(BigInt(chat.id));
        w.writeLong(chat.accessHash);
        writeTlString(w, chat.title);
        // username: not present (flag 6 not set)
        writeChatPhoto(w, chat.photoId, messageStore);
        w.writeInt(chat.date);
    }
    else {
        // chat#41cbf256 flags:# creator:flags.0?true left:flags.2?true deactivated:flags.5?true ...
        // id:long title:string photo:ChatPhoto participants_count:int date:int version:int
        // migrated_to:flags.6?InputChannel admin_rights:flags.14?ChatAdminRights default_banned_rights:flags.18?ChatBannedRights
        let flags = 0;
        if (chat.creatorUserId === selfId)
            flags |= (1 << 0); // creator
        w.writeInt(0x41cbf256); // chat constructor
        w.writeInt(flags);
        w.writeLong(BigInt(chat.id));
        writeTlString(w, chat.title);
        writeChatPhoto(w, chat.photoId, messageStore);
        w.writeInt(chat.participantsCount);
        w.writeInt(chat.date);
        w.writeInt(1); // version
        // migrated_to: not present (flag 6 not set)
        // admin_rights: not present (flag 14 not set)
        // default_banned_rights: not present (flag 18 not set)
    }
}
/** Write chatPhoto or chatPhotoEmpty depending on whether a photo media exists */
function writeChatPhoto(w, photoId, messageStore) {
    if (!photoId) {
        writeChatPhotoEmpty(w);
        return;
    }
    const media = messageStore.getMedia(photoId);
    if (!media) {
        writeChatPhotoEmpty(w);
        return;
    }
    // chatPhoto#1c6e1c11 flags:# has_video:flags.0?true photo_id:long stripped_thumb:flags.1?bytes dc_id:int
    w.writeInt(0x1c6e1c11);
    w.writeInt(0); // flags: no has_video, no stripped_thumb
    const publicPhotoId = (BigInt(media.createdAt) << 20n) | BigInt(media.id);
    w.writeLong(publicPhotoId);
    w.writeInt(2); // dc_id
}
export function writeChannelFromFixture(w, chat) {
    let flags = 0;
    if (chat.creator)
        flags |= (1 << 0);
    if (chat.broadcast)
        flags |= (1 << 5);
    if (chat.username)
        flags |= (1 << 6);
    if (chat.accessHash)
        flags |= (1 << 13);
    w.writeInt(0x1c32b11c);
    w.writeInt(flags);
    w.writeInt(0); // flags2
    w.writeLong(BigInt(chat.id));
    if (chat.accessHash) {
        w.writeLong(BigInt(chat.accessHash));
    }
    writeTlString(w, chat.title);
    if (chat.username) {
        writeTlString(w, chat.username);
    }
    writeChatPhotoEmpty(w);
    w.writeInt(chat.date);
}
// ========== Dialog writer ==========
export function writeDialogFromFixture(w, dialog) {
    // dialog#d58a08c6 flags:# pinned:flags.2?true unread_mark:flags.3?true view_forum_as_messages:flags.6?true peer:Peer top_message:int read_inbox_max_id:int read_outbox_max_id:int unread_count:int unread_mentions_count:int unread_reactions_count:int notify_settings:PeerNotifySettings ...
    w.writeInt(0xd58a08c6);
    let flags = 0;
    if (dialog.pts !== undefined)
        flags |= (1 << 0);
    if (dialog.draftDate !== undefined)
        flags |= (1 << 1);
    w.writeInt(flags);
    writePeerByKey(w, dialog.peerKey);
    w.writeInt(dialog.topMessage);
    w.writeInt(dialog.readInboxMaxId);
    w.writeInt(dialog.readOutboxMaxId);
    w.writeInt(dialog.unreadCount);
    w.writeInt(dialog.unreadMentionsCount);
    w.writeInt(dialog.unreadReactionsCount);
    writePeerNotifySettingsToWriter(w);
    if (dialog.pts !== undefined) {
        w.writeInt(dialog.pts);
    }
    if (dialog.draftDate !== undefined) {
        writeDraftMessageEmpty(w, dialog.draftDate);
    }
}
// ========== Vector writers ==========
export function writeDialogVector(w, dialogs) {
    w.writeInt(0x1cb5c415);
    w.writeInt(dialogs.length);
    for (const dialog of dialogs) {
        writeDialogFromFixture(w, dialog);
    }
}
export function writeMessageVector(w, messages) {
    w.writeInt(0x1cb5c415);
    w.writeInt(messages.length);
    for (const message of messages) {
        writeMessageFromFixture(w, message);
    }
}
export function writeUserVector(w, fixture, userIds) {
    const uniqueUserIds = Array.from(new Set(userIds));
    w.writeInt(0x1cb5c415);
    w.writeInt(uniqueUserIds.length);
    for (const userId of uniqueUserIds) {
        const user = fixture.usersById[userId];
        if (user) {
            writeUserFromFixture(w, user);
            continue;
        }
        writeFallbackUserFromId(w, userId);
    }
}
export function writeChatVector(w, fixture, chatIds) {
    const chats = Array.from(new Set(chatIds))
        .map((chatId) => fixture.chatsById[chatId])
        .filter((chat) => Boolean(chat));
    w.writeInt(0x1cb5c415);
    w.writeInt(chats.length);
    for (const chat of chats) {
        writeChatFromFixture(w, chat);
    }
}
// ========== Misc TL structure writers ==========
export function writePeerNotifySettingsToWriter(w) {
    // peerNotifySettings#99622c0c flags:#
    //   show_previews:flags.0?Bool silent:flags.1?Bool mute_until:flags.2?int
    //   ios_sound:flags.3?NotificationSound android_sound:flags.4?NotificationSound other_sound:flags.5?NotificationSound
    w.writeInt(0x99622c0c);
    const flags = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5); // 63
    w.writeInt(flags);
    w.writeInt(0x997275b5); // show_previews = boolTrue
    w.writeInt(0xbc799737); // silent = boolFalse
    w.writeInt(0); // mute_until = 0
    // ios_sound: notificationSoundDefault#97e8bebe
    w.writeInt(0x97e8bebe);
    // android_sound: notificationSoundLocal#830b9ae4 title:"default" data:"default"
    w.writeInt(0x830b9ae4);
    writeTlString(w, 'default');
    writeTlString(w, 'default');
    // other_sound: notificationSoundLocal#830b9ae4 title:"default" data:"default"
    w.writeInt(0x830b9ae4);
    writeTlString(w, 'default');
    writeTlString(w, 'default');
}
export function writeDraftMessageEmpty(w, date) {
    // draftMessageEmpty#1b0c841a flags:# date:int
    w.writeInt(0x1b0c841a);
    w.writeInt(1);
    w.writeInt(date);
}
export function writeDraftMessage(w, text, date, replyToMsgId) {
    // draftMessage#96eaa5eb flags:# no_webpage:flags.1?true invert_media:flags.6?true
    // reply_to:flags.4?InputReplyTo message:string entities:flags.3?Vector<MessageEntity>
    // media:flags.5?InputMedia date:int effect:flags.7?long suggested_post:flags.8?SuggestedPost
    let draftFlags = 0;
    if (replyToMsgId)
        draftFlags |= (1 << 4); // reply_to present
    w.writeInt(0x96eaa5eb);
    w.writeInt(draftFlags);
    if (replyToMsgId) {
        // Web client: inputReplyToMessage#869fbe10, GramJS npm: inputReplyToMessage#22c0f6d5
        w.writeInt(isWebClient() ? 0x869fbe10 : 0x22c0f6d5);
        w.writeInt(0); // flags
        w.writeInt(replyToMsgId);
    }
    writeTlString(w, text);
    // entities: not present (flag 3 not set)
    // media: not present (flag 5 not set)
    w.writeInt(date);
    // effect: not present (flag 7 not set)
    // suggested_post: not present (flag 8 not set)
}
export function writeChatPhotoEmpty(w) {
    w.writeInt(0x37c1011c);
}
export function writePhotoEmpty(w, photoId) {
    // photoEmpty#2331b22d id:long
    w.writeInt(0x2331b22d);
    w.writeLong(photoId);
}
export function writeUpdatesStateToWriter(w, userId) {
    const state = messageStore.getUpdateState(userId);
    w.writeInt(0xa56c2a3e);
    w.writeInt(state.pts);
    w.writeInt(state.qts);
    w.writeInt(state.date);
    w.writeInt(state.seq);
    w.writeInt(state.unreadCount);
}
export function writePeerColorSet(w, colors) {
    w.writeInt(0x26219a58); // help.peerColorSet
    w.writeInt(0x1cb5c415);
    w.writeInt(colors.length);
    for (const color of colors) {
        w.writeInt(color);
    }
}
export function writePeerColorProfileSet(w, colors) {
    w.writeInt(0x767d61eb); // help.peerColorProfileSet
    writeIntVector(w, colors);
    writeIntVector(w, colors);
    writeIntVector(w, colors);
}
//# sourceMappingURL=writers.js.map