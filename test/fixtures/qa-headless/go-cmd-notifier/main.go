// Go CLI/notifier fixture — shape-detection-only in v1.
// /qa-headless should detect this as a 'notifier' (or 'CLI') and route to manual guidance.
//
// Go is fundamentally harder to capture than Python (compiled, no monkeypatch).
// v1 detects + exits gracefully; v1.x will likely require a proxy mode.

package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
)

func main() {
	dryRun := flag.Bool("dry-run", false, "capture instead of POSTing")
	userID := flag.Int("user-id", 0, "user ID")
	message := flag.String("message", "", "notification body")
	flag.Parse()

	webhook := os.Getenv("SLACK_WEBHOOK_URL")
	payload := map[string]any{
		"text": fmt.Sprintf("User %d: %s", *userID, *message),
	}
	body, _ := json.Marshal(payload)

	if *dryRun {
		fmt.Printf("DRY RUN payload: %s\n", body)
		return
	}

	resp, err := http.Post(webhook, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "post failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	fmt.Printf("status: %d\n", resp.StatusCode)
}
