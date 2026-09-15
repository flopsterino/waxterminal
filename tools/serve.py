#!/usr/bin/env python3
"""Threaded static server for local and Tailscale use.

python -m http.server is single-threaded: the terminal fires a couple of dozen
parallel fetches on load (the history files, the snapshot, the modules) and a
serial server turns that into a deadlock that looks exactly like a frontend bug.
GitHub Pages is concurrent, so this only bites locally — which is worse, because
it bites while you are debugging something else.
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.ndjson': 'application/x-ndjson',
    }

    def end_headers(self):
        # Always revalidate: this server exists for development.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        # The app routes on real paths (/markets, /market/alcor:314), which on
        # GitHub Pages fall through to 404.html and bounce back to index. Do the
        # same here, or every deep link is a 404 while developing.
        if code == 404 and 'text/html' in (self.headers.get('Accept') or ''):
            self.path = '/404.html'
            try:
                return SimpleHTTPRequestHandler.do_GET(self)
            except Exception:
                pass
        return super().send_error(code, message, explain)

    def log_message(self, fmt, *args):
        if os.environ.get('SERVE_QUIET'):
            return
        super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8110
    root = sys.argv[2] if len(sys.argv) > 2 else '.'
    srv = ThreadingHTTPServer(('0.0.0.0', port), partial(Handler, directory=root))
    srv.daemon_threads = True
    print(f'serving {root} on 0.0.0.0:{port}', flush=True)
    srv.serve_forever()
