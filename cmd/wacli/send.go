package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/steipete/wacli/internal/app"
	"github.com/steipete/wacli/internal/linkpreview"
	"github.com/steipete/wacli/internal/out"
	"github.com/steipete/wacli/internal/store"
	"github.com/steipete/wacli/internal/wa"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func newSendCmd(flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "send",
		Short: "Send messages",
	}
	cmd.AddCommand(newSendTextCmd(flags))
	cmd.AddCommand(newSendFileCmd(flags))
	cmd.AddCommand(newSendVoiceCmd(flags))
	cmd.AddCommand(newSendReactCmd(flags))
	return cmd
}

func newSendTextCmd(flags *rootFlags) *cobra.Command {
	var to string
	var pick int
	var message string
	var replyTo string
	var replyToSender string
	var mentions []string
	var noPreview bool
	postSendWait := postSendRetryReceiptWait

	cmd := &cobra.Command{
		Use:   "text",
		Short: "Send a text message",
		RunE: func(cmd *cobra.Command, args []string) error {
			if to == "" || message == "" {
				return fmt.Errorf("--to and --message are required")
			}
			if err := flags.requireWritable(); err != nil {
				return err
			}

			ctx, cancel := withTimeout(context.Background(), flags)
			defer cancel()

			a, lk, err := newApp(ctx, flags, true, false)
			if err != nil {
				return err
			}
			defer closeApp(a, lk)

			if err := a.EnsureAuthed(); err != nil {
				return err
			}

			toJID, err := resolveRecipient(a, to, recipientOptions{pick: pick, asJSON: flags.asJSON})
			if err != nil {
				return err
			}
			if err := a.Connect(ctx, false, nil); err != nil {
				return err
			}
			if err := warnRapidSendIfNeeded(a.StoreDir(), time.Now().UTC(), os.Stderr); err != nil {
				return err
			}

			preview := fetchLinkPreview(ctx, message, noPreview)
			msgID, err := runSendOperation(ctx, reconnectForSend(a), func(ctx context.Context) (types.MessageID, error) {
				return sendTextMessage(ctx, a, toJID, message, replyTo, replyToSender, mentions, preview)
			})
			if err != nil {
				return err
			}

			now := time.Now().UTC()
			chat := toJID
			chatName := a.WA().ResolveChatName(ctx, chat, "")
			kind := chatKindFromJID(chat)
			_ = a.DB().UpsertChat(chat.String(), kind, chatName, now)
			_ = a.DB().UpsertMessage(store.UpsertMessageParams{
				ChatJID:    chat.String(),
				ChatName:   chatName,
				MsgID:      string(msgID),
				SenderJID:  "",
				SenderName: "me",
				Timestamp:  now,
				FromMe:     true,
				Text:       message,
			})

			waitForPostSendRetryReceipts(ctx, postSendWait)

			if flags.asJSON {
				return out.WriteJSON(os.Stdout, map[string]any{
					"sent": true,
					"to":   chat.String(),
					"id":   msgID,
				})
			}
			fmt.Fprintf(os.Stdout, "Sent to %s (id %s)\n", chat.String(), msgID)
			return nil
		},
	}

	cmd.Flags().StringVar(&to, "to", "", "recipient JID, phone number, or contact/group/chat name")
	cmd.Flags().IntVar(&pick, "pick", 0, "when --to is ambiguous, pick the Nth match (1-indexed)")
	cmd.Flags().StringVar(&message, "message", "", "message text")
	cmd.Flags().StringVar(&replyTo, "reply-to", "", "message ID to quote/reply to")
	cmd.Flags().StringVar(&replyToSender, "reply-to-sender", "", "sender JID of the quoted message (required for unsynced group replies)")
	cmd.Flags().StringArrayVar(&mentions, "mention", nil, "user JID or phone number to mention (repeatable)")
	cmd.Flags().BoolVar(&noPreview, "no-preview", false, "disable automatic link previews for the first URL in text")
	cmd.Flags().DurationVar(&postSendWait, "post-send-wait", postSendRetryReceiptWait, "keep the connection alive after send so retry receipts can be handled (0 disables)")
	return cmd
}

type sendTextApp interface {
	WA() app.WAClient
	DB() *store.DB
}

func sendTextMessage(ctx context.Context, a sendTextApp, to types.JID, text, replyTo, replyToSender string, mentions []string, preview *linkpreview.Preview) (types.MessageID, error) {
	msg, plainText, err := buildTextMessage(a.DB(), to, text, replyTo, replyToSender, mentions, preview)
	if err != nil {
		return "", err
	}
	if plainText {
		return a.WA().SendText(ctx, to, text)
	}
	return a.WA().SendProtoMessage(ctx, to, msg)
}

func fetchLinkPreview(ctx context.Context, text string, disabled bool) *linkpreview.Preview {
	if disabled {
		return nil
	}
	rawURL := linkpreview.FindFirstHTTPURL(text)
	if rawURL == "" {
		return nil
	}
	previewCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	preview, err := linkpreview.Fetch(previewCtx, nil, rawURL)
	if err != nil {
		return nil
	}
	return preview
}

func buildTextMessage(db *store.DB, to types.JID, text, replyTo, replyToSender string, mentions []string, preview *linkpreview.Preview) (*waProto.Message, bool, error) {
	info, err := buildTextContextInfo(db, to, replyTo, replyToSender, mentions)
	if err != nil {
		return nil, false, err
	}
	if info == nil && preview == nil {
		return nil, true, nil
	}

	ext := &waProto.ExtendedTextMessage{
		Text:        proto.String(text),
		ContextInfo: info,
	}
	attachLinkPreview(ext, preview)
	return &waProto.Message{ExtendedTextMessage: ext}, false, nil
}

func attachLinkPreview(msg *waProto.ExtendedTextMessage, preview *linkpreview.Preview) {
	if preview == nil {
		return
	}
	if preview.URL != "" {
		msg.MatchedText = proto.String(preview.URL)
	}
	if preview.Title != "" {
		msg.Title = proto.String(preview.Title)
	}
	if preview.Description != "" {
		msg.Description = proto.String(preview.Description)
	}
	if len(preview.Thumbnail) > 0 {
		msg.PreviewType = waProto.ExtendedTextMessage_IMAGE.Enum()
		msg.JPEGThumbnail = preview.Thumbnail
		return
	}
	msg.PreviewType = waProto.ExtendedTextMessage_NONE.Enum()
}

func buildTextContextInfo(db *store.DB, chat types.JID, replyTo, replyToSender string, mentions []string) (*waProto.ContextInfo, error) {
	info, err := buildReplyContextInfo(db, chat, replyTo, replyToSender)
	if err != nil {
		return nil, err
	}

	mentioned, err := normalizeMentionJIDs(mentions)
	if err != nil {
		return nil, err
	}
	if len(mentioned) == 0 {
		return info, nil
	}
	if chat.Server != types.GroupServer {
		return nil, fmt.Errorf("--mention is only supported for group text messages")
	}
	if info == nil {
		info = &waProto.ContextInfo{}
	}
	info.MentionedJID = mentioned
	return info, nil
}

func normalizeMentionJIDs(raw []string) ([]string, error) {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(raw))
	for _, input := range raw {
		jid, err := wa.ParseUserOrJID(input)
		if err != nil {
			return nil, fmt.Errorf("invalid --mention %q: %w", input, err)
		}
		jid = jid.ToNonAD()
		if jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer {
			return nil, fmt.Errorf("invalid --mention %q: must be a user JID or phone number", input)
		}
		normalized := jid.String()
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	return out, nil
}

func buildReplyContextInfo(db *store.DB, chat types.JID, replyTo, replyToSender string) (*waProto.ContextInfo, error) {
	replyTo = strings.TrimSpace(replyTo)
	if replyTo == "" {
		return nil, nil
	}

	sender, err := resolveReplySender(db, chat, replyTo, replyToSender)
	if err != nil {
		return nil, err
	}

	stanzaID := replyTo
	info := &waProto.ContextInfo{StanzaID: proto.String(stanzaID)}
	if !sender.IsEmpty() {
		participant := sender.String()
		info.Participant = proto.String(participant)
	}
	return info, nil
}

func resolveReplySender(db *store.DB, chat types.JID, replyTo, override string) (types.JID, error) {
	if strings.TrimSpace(override) != "" {
		jid, err := wa.ParseUserOrJID(override)
		if err != nil {
			return types.JID{}, fmt.Errorf("invalid --reply-to-sender: %w", err)
		}
		return jid, nil
	}

	msg, err := db.GetMessage(chat.String(), replyTo)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return types.JID{}, fmt.Errorf("lookup quoted message: %w", err)
	}
	if err == nil && strings.TrimSpace(msg.SenderJID) != "" {
		jid, err := types.ParseJID(msg.SenderJID)
		if err != nil {
			return types.JID{}, fmt.Errorf("stored quoted sender is invalid: %w", err)
		}
		return jid, nil
	}

	if chat.Server == types.GroupServer {
		return types.JID{}, fmt.Errorf("--reply-to-sender is required for unsynced group replies")
	}
	return types.JID{}, nil
}
