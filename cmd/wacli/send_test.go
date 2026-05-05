package main

import (
	"strings"
	"testing"
	"time"

	"github.com/steipete/wacli/internal/linkpreview"
	"github.com/steipete/wacli/internal/store"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types"
)

func openSendTestDB(t *testing.T) *store.DB {
	t.Helper()
	db, err := store.Open(t.TempDir() + "/wacli.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

type recipientTestApp struct {
	db *store.DB
}

func (a recipientTestApp) DB() *store.DB {
	return a.db
}

func TestResolveRecipientFallsBackToFormattedPhone(t *testing.T) {
	db := openSendTestDB(t)

	got, err := resolveRecipient(recipientTestApp{db: db}, "+1 (555) 123-4567", recipientOptions{})
	if err != nil {
		t.Fatalf("resolveRecipient: %v", err)
	}
	if got.String() != "15551234567@s.whatsapp.net" {
		t.Fatalf("recipient = %q", got.String())
	}
}

func TestResolveRecipientUsesContactAlias(t *testing.T) {
	db := openSendTestDB(t)
	if err := db.UpsertContact("15551234567@s.whatsapp.net", "15551234567", "Alice", "", "", ""); err != nil {
		t.Fatalf("UpsertContact: %v", err)
	}
	if err := db.SetAlias("15551234567@s.whatsapp.net", "mom"); err != nil {
		t.Fatalf("SetAlias: %v", err)
	}

	got, err := resolveRecipient(recipientTestApp{db: db}, "mom", recipientOptions{})
	if err != nil {
		t.Fatalf("resolveRecipient: %v", err)
	}
	if got.String() != "15551234567@s.whatsapp.net" {
		t.Fatalf("recipient = %q", got.String())
	}
}

func TestResolveRecipientNumericGroupNameBeatsPhoneFallback(t *testing.T) {
	db := openSendTestDB(t)
	if err := db.UpsertGroup("12345@g.us", "12345", "", time.Now()); err != nil {
		t.Fatalf("UpsertGroup: %v", err)
	}

	got, err := resolveRecipient(recipientTestApp{db: db}, "12345", recipientOptions{})
	if err != nil {
		t.Fatalf("resolveRecipient: %v", err)
	}
	if got.String() != "12345@g.us" {
		t.Fatalf("recipient = %q", got.String())
	}
}

func TestResolveRecipientNumericDirectChatDoesNotHijackPhone(t *testing.T) {
	db := openSendTestDB(t)
	if err := db.UpsertChat("999@s.whatsapp.net", "dm", "1234567", time.Now()); err != nil {
		t.Fatalf("UpsertChat: %v", err)
	}

	got, err := resolveRecipient(recipientTestApp{db: db}, "1234567", recipientOptions{})
	if err != nil {
		t.Fatalf("resolveRecipient: %v", err)
	}
	if got.String() != "1234567@s.whatsapp.net" {
		t.Fatalf("recipient = %q", got.String())
	}
}

func TestResolveRecipientAmbiguousRequiresPickWhenNonInteractive(t *testing.T) {
	db := openSendTestDB(t)
	if err := db.UpsertContact("1@s.whatsapp.net", "1", "", "John", "", ""); err != nil {
		t.Fatalf("UpsertContact 1: %v", err)
	}
	if err := db.UpsertContact("2@s.whatsapp.net", "2", "", "Johnny", "", ""); err != nil {
		t.Fatalf("UpsertContact 2: %v", err)
	}

	_, err := resolveRecipient(recipientTestApp{db: db}, "John", recipientOptions{})
	if err == nil || !strings.Contains(err.Error(), "use --pick N") {
		t.Fatalf("expected --pick ambiguity, got %v", err)
	}
	if !strings.Contains(err.Error(), "1)") || !strings.Contains(err.Error(), "2)") {
		t.Fatalf("expected numbered candidates, got %v", err)
	}
}

func TestResolveRecipientPickSelectsCandidate(t *testing.T) {
	db := openSendTestDB(t)
	if err := db.UpsertContact("1@s.whatsapp.net", "1", "", "John", "", ""); err != nil {
		t.Fatalf("UpsertContact 1: %v", err)
	}
	if err := db.UpsertContact("2@s.whatsapp.net", "2", "", "Johnny", "", ""); err != nil {
		t.Fatalf("UpsertContact 2: %v", err)
	}

	got, err := resolveRecipient(recipientTestApp{db: db}, "John", recipientOptions{pick: 2})
	if err != nil {
		t.Fatalf("resolveRecipient: %v", err)
	}
	if got.String() != "2@s.whatsapp.net" {
		t.Fatalf("recipient = %q", got.String())
	}
}

func TestResolveReplySenderFromStore(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "12345", Server: types.GroupServer}
	sender := "15551234567@s.whatsapp.net"

	if err := db.UpsertChat(chat.String(), "group", "Group", time.Now()); err != nil {
		t.Fatalf("UpsertChat: %v", err)
	}
	if err := db.UpsertMessage(store.UpsertMessageParams{
		ChatJID:   chat.String(),
		MsgID:     "quoted",
		SenderJID: sender,
		Timestamp: time.Now(),
		Text:      "hello",
	}); err != nil {
		t.Fatalf("UpsertMessage: %v", err)
	}

	got, err := resolveReplySender(db, chat, "quoted", "")
	if err != nil {
		t.Fatalf("resolveReplySender: %v", err)
	}
	if got.String() != sender {
		t.Fatalf("sender = %q, want %q", got.String(), sender)
	}
}

func TestResolveReplySenderOverride(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "12345", Server: types.GroupServer}

	got, err := resolveReplySender(db, chat, "missing", "+15551234567")
	if err != nil {
		t.Fatalf("resolveReplySender: %v", err)
	}
	if got.String() != "15551234567@s.whatsapp.net" {
		t.Fatalf("sender = %q", got.String())
	}
}

func TestResolveReplySenderRequiresGroupSenderWhenMissing(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "12345", Server: types.GroupServer}

	_, err := resolveReplySender(db, chat, "missing", "")
	if err == nil || !strings.Contains(err.Error(), "--reply-to-sender is required") {
		t.Fatalf("expected group sender error, got %v", err)
	}
}

func TestResolveReplySenderAllowsDirectMessageWithoutSender(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "15551234567", Server: types.DefaultUserServer}

	got, err := resolveReplySender(db, chat, "missing", "")
	if err != nil {
		t.Fatalf("resolveReplySender: %v", err)
	}
	if !got.IsEmpty() {
		t.Fatalf("expected empty sender for direct reply, got %q", got.String())
	}
}

func TestBuildReplyContextInfo(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "12345", Server: types.GroupServer}

	got, err := buildReplyContextInfo(db, chat, "quoted", "+15551234567")
	if err != nil {
		t.Fatalf("buildReplyContextInfo: %v", err)
	}
	if got.GetStanzaID() != "quoted" {
		t.Fatalf("stanza ID = %q, want quoted", got.GetStanzaID())
	}
	if got.GetParticipant() != "15551234567@s.whatsapp.net" {
		t.Fatalf("participant = %q", got.GetParticipant())
	}

	got, err = buildReplyContextInfo(db, chat, "", "+15551234567")
	if err != nil {
		t.Fatalf("empty buildReplyContextInfo: %v", err)
	}
	if got != nil {
		t.Fatalf("empty reply context = %v, want nil", got)
	}
}

func TestSendTextCommandExposesTextFlags(t *testing.T) {
	cmd := newSendTextCmd(&rootFlags{})
	for _, name := range []string{"no-preview", "mention"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Fatalf("missing --%s flag", name)
		}
	}
}

func TestBuildTextMessageUsesPlainConversationWithoutReplyOrPreview(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "15551234567", Server: types.DefaultUserServer}

	msg, plain, err := buildTextMessage(db, chat, "hello", "", "", nil, nil)
	if err != nil {
		t.Fatalf("buildTextMessage: %v", err)
	}
	if !plain {
		t.Fatalf("plain = false, want true")
	}
	if msg != nil {
		t.Fatalf("msg = %v, want nil", msg)
	}
}

func TestBuildTextMessageAttachesMentions(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "12345", Server: types.GroupServer}

	msg, plain, err := buildTextMessage(db, chat, "@alice @bob", "", "", []string{
		"+1 (555) 123-4567",
		"999123456@lid",
		"15551234567@s.whatsapp.net",
	}, nil)
	if err != nil {
		t.Fatalf("buildTextMessage: %v", err)
	}
	if plain {
		t.Fatalf("plain = true, want false")
	}
	got := msg.GetExtendedTextMessage().GetContextInfo().GetMentionedJID()
	want := []string{"15551234567@s.whatsapp.net", "999123456@lid"}
	if len(got) != len(want) {
		t.Fatalf("mentioned JIDs = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("mentioned JIDs = %#v, want %#v", got, want)
		}
	}
}

func TestBuildTextMessageRejectsGroupMention(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "12345", Server: types.GroupServer}

	_, _, err := buildTextMessage(db, chat, "hello", "", "", []string{"12345@g.us"}, nil)
	if err == nil || !strings.Contains(err.Error(), "must be a user JID or phone number") {
		t.Fatalf("expected group mention rejection, got %v", err)
	}
}

func TestBuildTextMessageRejectsMentionsOutsideGroups(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "15551234567", Server: types.DefaultUserServer}

	_, _, err := buildTextMessage(db, chat, "hello", "", "", []string{"+15557654321"}, nil)
	if err == nil || !strings.Contains(err.Error(), "only supported for group text messages") {
		t.Fatalf("expected direct-chat mention rejection, got %v", err)
	}
}

func TestBuildTextMessageCombinesReplyAndMentions(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "12345", Server: types.GroupServer}

	msg, plain, err := buildTextMessage(db, chat, "@alice replying", "quoted", "+15557654321", []string{"+15551234567"}, nil)
	if err != nil {
		t.Fatalf("buildTextMessage: %v", err)
	}
	if plain {
		t.Fatalf("plain = true, want false")
	}
	info := msg.GetExtendedTextMessage().GetContextInfo()
	if info.GetStanzaID() != "quoted" {
		t.Fatalf("stanza ID = %q, want quoted", info.GetStanzaID())
	}
	if info.GetParticipant() != "15557654321@s.whatsapp.net" {
		t.Fatalf("participant = %q", info.GetParticipant())
	}
	got := info.GetMentionedJID()
	if len(got) != 1 || got[0] != "15551234567@s.whatsapp.net" {
		t.Fatalf("mentioned JIDs = %#v", got)
	}
}

func TestBuildTextMessageAttachesLinkPreview(t *testing.T) {
	db := openSendTestDB(t)
	chat := types.JID{User: "15551234567", Server: types.DefaultUserServer}
	preview := &linkpreview.Preview{
		URL:         "https://example.com/post",
		Title:       "Example",
		Description: "Description",
		Thumbnail:   []byte("jpeg"),
	}

	msg, plain, err := buildTextMessage(db, chat, "see https://example.com/post", "", "", nil, preview)
	if err != nil {
		t.Fatalf("buildTextMessage: %v", err)
	}
	if plain {
		t.Fatalf("plain = true, want false")
	}
	ext := msg.GetExtendedTextMessage()
	if ext.GetText() != "see https://example.com/post" {
		t.Fatalf("text = %q", ext.GetText())
	}
	if ext.GetMatchedText() != preview.URL {
		t.Fatalf("matched text = %q", ext.GetMatchedText())
	}
	if ext.GetTitle() != preview.Title {
		t.Fatalf("title = %q", ext.GetTitle())
	}
	if ext.GetDescription() != preview.Description {
		t.Fatalf("description = %q", ext.GetDescription())
	}
	if ext.GetPreviewType() != waProto.ExtendedTextMessage_IMAGE {
		t.Fatalf("preview type = %v", ext.GetPreviewType())
	}
	if string(ext.GetJPEGThumbnail()) != "jpeg" {
		t.Fatalf("thumbnail = %q", string(ext.GetJPEGThumbnail()))
	}
}
