//go:build !darwin

package syscontacts

import "context"

func ReadSystem(ctx context.Context) ([]Contact, error) {
	return nil, UnsupportedError()
}
