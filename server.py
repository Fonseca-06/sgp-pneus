import http.server, socketserver

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

with socketserver.TCPServer(("", 8020), NoCacheHandler) as httpd:
    print("Mira Sales rodando em http://localhost:8020")
    httpd.serve_forever()
