from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


DEFAULT_URL = "https://pixelbypixel.studio/mcp"
DEFAULT_PROTOCOL_VERSION = "2025-03-26"
DEFAULT_CLIENT_ID = "pbp_mcp_65d544c5a639e953590e09c3c12db4a5"


class MpcClientError(RuntimeError):
    pass


@dataclass
class JsonRpcResponse:
    status: int
    headers: dict[str, str]
    body: dict[str, Any] | list[Any] | None


@dataclass
class UsageMetrics:
    llm_tokens: int = 0
    http_calls: int = 0
    bytes_sent: int = 0
    bytes_received: int = 0


class StreamableHttpMcpClient:
    def __init__(
        self,
        url: str,
        token: str | None,
        timeout_seconds: int = 30,
        metrics: UsageMetrics | None = None,
    ):
        self.url = url
        self.token = token
        self.timeout_seconds = timeout_seconds
        self.session_id: str | None = None
        self._next_id = 1
        self.metrics = metrics or UsageMetrics()

    def discover(self) -> dict[str, Any]:
        req = urllib.request.Request(self.url, method="GET")
        try:
            self.metrics.http_calls += 1
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                payload = resp.read().decode("utf-8")
                self.metrics.bytes_received += len(payload.encode("utf-8"))
                return json.loads(payload)
        except urllib.error.URLError as err:
            raise MpcClientError(f"discover failed: {err}") from err

    def initialize(self) -> None:
        params = {
            "protocolVersion": DEFAULT_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "pbp-mcp-cli", "version": "0.2.0"},
        }
        init = self._rpc("initialize", params)
        self._raise_if_rpc_error(init)

        initialized = self._rpc_notification("notifications/initialized", {})
        if initialized.status >= 400:
            raise MpcClientError(
                f"initialized notification failed: HTTP {initialized.status}"
            )

    def tools_list(self) -> dict[str, Any]:
        result = self._rpc("tools/list", {})
        self._raise_if_rpc_error(result)
        return self._extract_result(result)

    def tool_call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        self._raise_if_rpc_error(result)
        return self._extract_result(result)

    def _rpc(self, method: str, params: dict[str, Any]) -> JsonRpcResponse:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
            "params": params,
        }
        self._next_id += 1
        return self._post_json(payload)

    def _rpc_notification(self, method: str, params: dict[str, Any]) -> JsonRpcResponse:
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        return self._post_json(payload)

    def _post_json(self, payload: dict[str, Any]) -> JsonRpcResponse:
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if self.session_id:
            headers["mcp-session-id"] = self.session_id

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.url, data=data, headers=headers, method="POST")

        try:
            self.metrics.http_calls += 1
            self.metrics.bytes_sent += len(data)
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                body_raw = resp.read().decode("utf-8")
                self.metrics.bytes_received += len(body_raw.encode("utf-8"))
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                session_id = resp_headers.get("mcp-session-id")
                if session_id:
                    self.session_id = session_id
                body = json.loads(body_raw) if body_raw else None
                return JsonRpcResponse(resp.status, resp_headers, body)
        except urllib.error.HTTPError as err:
            body_raw = err.read().decode("utf-8") if err.fp else ""
            self.metrics.bytes_received += len(body_raw.encode("utf-8"))
            resp_headers = {k.lower(): v for k, v in err.headers.items()} if err.headers else {}
            if "mcp-session-id" in resp_headers:
                self.session_id = resp_headers["mcp-session-id"]
            body: dict[str, Any] | list[Any] | None
            try:
                body = json.loads(body_raw) if body_raw else None
            except json.JSONDecodeError:
                body = {"raw": body_raw} if body_raw else None
            return JsonRpcResponse(err.code, resp_headers, body)
        except urllib.error.URLError as err:
            raise MpcClientError(f"network error: {err}") from err

    @staticmethod
    def _extract_result(resp: JsonRpcResponse) -> dict[str, Any]:
        if not isinstance(resp.body, dict):
            return {}
        result = resp.body.get("result")
        if isinstance(result, dict):
            return result
        return {"result": result}

    @staticmethod
    def _raise_if_rpc_error(resp: JsonRpcResponse) -> None:
        if resp.status >= 400:
            raise MpcClientError(StreamableHttpMcpClient._format_http_error(resp))
        if isinstance(resp.body, dict) and "error" in resp.body:
            err = resp.body["error"]
            raise MpcClientError(f"RPC error: {json.dumps(err, ensure_ascii=True)}")

    @staticmethod
    def _format_http_error(resp: JsonRpcResponse) -> str:
        details = ""
        if resp.body is not None:
            details = f" body={json.dumps(resp.body, ensure_ascii=True)}"
        return f"HTTP {resp.status}{details}"


def _default_token_file() -> str:
    return os.path.join(os.path.expanduser("~"), ".pbp-mcp", "token.json")


def _read_saved_token(token_file: str) -> dict[str, Any] | None:
    if not os.path.exists(token_file):
        return None
    with open(token_file, "r", encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        return None
    return payload


def _resolve_token(explicit_token: str | None, token_file: str) -> str | None:
    if explicit_token:
        return explicit_token
    env = os.getenv("PBP_BEARER_TOKEN")
    if env:
        return env
    saved = _read_saved_token(token_file)
    if not saved:
        return None
    token = saved.get("access_token")
    if isinstance(token, str) and token:
        return token
    return None


def _save_token(token_file: str, token_payload: dict[str, Any]) -> None:
    directory = os.path.dirname(token_file)
    if directory:
        os.makedirs(directory, exist_ok=True)

    created_at = datetime.now(timezone.utc)
    record = dict(token_payload)
    record["created_at"] = created_at.isoformat()

    expires_in = record.get("expires_in")
    if isinstance(expires_in, (int, float)):
        expires_at = created_at.timestamp() + float(expires_in)
        record["expires_at"] = datetime.fromtimestamp(
            expires_at, tz=timezone.utc
        ).isoformat()

    with open(token_file, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2, sort_keys=True)


class _OAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    params: dict[str, str] = {}
    event: threading.Event | None = None

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        query = urllib.parse.parse_qs(parsed.query)
        flat = {k: v[0] for k, v in query.items() if v}
        _OAuthCallbackHandler.params = flat

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            b"Authentication complete. You can return to the terminal and close this tab."
        )

        if _OAuthCallbackHandler.event:
            _OAuthCallbackHandler.event.set()

    def log_message(self, format_str: str, *args: Any) -> None:  # noqa: A003
        return


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")
    return verifier, challenge


def _oauth_exchange_code(
    token_endpoint: str,
    client_id: str,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    form = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        token_endpoint,
        data=form,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body = resp.read().decode("utf-8")
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise MpcClientError("token endpoint returned non-object payload")
            return payload
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8") if err.fp else ""
        raise MpcClientError(f"token exchange failed: HTTP {err.code} body={body}") from err
    except urllib.error.URLError as err:
        raise MpcClientError(f"token exchange network error: {err}") from err


def _oauth_dynamic_register_client(
    registration_endpoint: str,
    redirect_uri: str,
    timeout_seconds: int,
    client_name: str = "pbp-mcp-cli",
) -> str:
    payload = {
        "redirect_uris": [redirect_uri],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "client_name": client_name,
    }
    data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        registration_endpoint,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body = resp.read().decode("utf-8")
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                raise MpcClientError("registration endpoint returned non-object payload")
            client_id = parsed.get("client_id")
            if not isinstance(client_id, str) or not client_id:
                raise MpcClientError(
                    f"registration endpoint missing client_id: {json.dumps(parsed, ensure_ascii=True)}"
                )
            return client_id
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8") if err.fp else ""
        raise MpcClientError(
            f"dynamic client registration failed: HTTP {err.code} body={body}"
        ) from err
    except urllib.error.URLError as err:
        raise MpcClientError(f"dynamic client registration network error: {err}") from err


def _discover_registration_endpoint(
    issuer: str,
    timeout_seconds: int,
) -> str | None:
    well_known = issuer.rstrip("/") + "/.well-known/oauth-authorization-server"
    req = urllib.request.Request(
        well_known,
        method="GET",
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body = resp.read().decode("utf-8")
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                return None
            registration_endpoint = parsed.get("registration_endpoint")
            if isinstance(registration_endpoint, str) and registration_endpoint:
                return registration_endpoint
            return None
    except Exception:  # pylint: disable=broad-except
        return None


def _parse_json_args(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise MpcClientError("--args must decode to a JSON object")
    return parsed


def _print_json(payload: Any) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def _print_usage(metrics: UsageMetrics, elapsed_ms: int) -> None:
    print(
        (
            "Token Use: "
            f"llm_tokens={metrics.llm_tokens} "
            f"http_calls={metrics.http_calls} "
            f"bytes_sent={metrics.bytes_sent} "
            f"bytes_received={metrics.bytes_received} "
            f"elapsed_ms={elapsed_ms}"
        ),
        file=sys.stderr,
    )


def _cmd_tools(client: StreamableHttpMcpClient, args: argparse.Namespace) -> int:
    discover = client.discover()
    tools = discover.get("tools", []) if isinstance(discover, dict) else []
    if args.json:
        _print_json({"tools": tools})
        return 0

    for t in tools:
        if isinstance(t, dict) and "name" in t:
            print(t["name"])
    return 0


def _cmd_call(client: StreamableHttpMcpClient, args: argparse.Namespace) -> int:
    if not client.token:
        raise MpcClientError(
            "Missing token. Run 'pbp-mcp login' or set PBP_BEARER_TOKEN / --token."
        )

    client.initialize()
    result = client.tool_call(args.tool_name, _parse_json_args(args.args))
    _print_json(result)
    return 0


def _cmd_whoami(client: StreamableHttpMcpClient, args: argparse.Namespace) -> int:
    args.tool_name = "who_am_i"
    args.args = "{}"
    return _cmd_call(client, args)


def _cmd_login(client: StreamableHttpMcpClient, args: argparse.Namespace) -> int:
    discover = client.discover()
    auth = discover.get("auth", {}) if isinstance(discover, dict) else {}

    auth_endpoint = args.auth_endpoint or auth.get("authorizationEndpoint")
    token_endpoint = args.token_endpoint or auth.get("tokenEndpoint")
    issuer = auth.get("issuer") if isinstance(auth, dict) else None

    if not auth_endpoint or not token_endpoint:
        raise MpcClientError(
            "OAuth endpoints not found in discovery. Pass --auth-endpoint and --token-endpoint."
        )

    state = secrets.token_urlsafe(24)
    code_verifier, code_challenge = _pkce_pair()

    _OAuthCallbackHandler.params = {}
    _OAuthCallbackHandler.event = threading.Event()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _OAuthCallbackHandler)
    redirect_uri = f"http://127.0.0.1:{server.server_port}/callback"

    registration_endpoint = args.registration_endpoint
    if not registration_endpoint and isinstance(issuer, str) and issuer:
        registration_endpoint = _discover_registration_endpoint(issuer, args.timeout)
    if not registration_endpoint and token_endpoint.endswith("/token"):
        registration_endpoint = token_endpoint[: -len("/token")] + "/register"

    client_id = args.client_id
    if not client_id:
        if not registration_endpoint:
            client_id = DEFAULT_CLIENT_ID
        else:
            client_id = _oauth_dynamic_register_client(
                registration_endpoint=registration_endpoint,
                redirect_uri=redirect_uri,
                timeout_seconds=args.timeout,
            )

    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    auth_params: dict[str, str] = {
        "response_type": "code",
        "client_id": client_id,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "redirect_uri": redirect_uri,
    }
    if args.scope:
        auth_params["scope"] = args.scope
    query = urllib.parse.urlencode(auth_params)
    authorize_url = f"{auth_endpoint}?{query}"

    print("Open this URL to authenticate:")
    print(authorize_url)

    if not args.no_browser:
        opened = webbrowser.open(authorize_url)
        if not opened:
            print("warning: failed to open browser automatically", file=sys.stderr)

    ok = _OAuthCallbackHandler.event.wait(timeout=args.login_timeout)
    server.shutdown()
    server.server_close()

    if not ok:
        raise MpcClientError("login timed out waiting for OAuth callback")

    callback = _OAuthCallbackHandler.params
    returned_state = callback.get("state")
    if returned_state != state:
        raise MpcClientError("OAuth state mismatch")

    if "error" in callback:
        err = callback.get("error", "unknown_error")
        desc = callback.get("error_description")
        uri = callback.get("error_uri")
        details = []
        if isinstance(desc, str) and desc:
            details.append(f"description={desc}")
        if isinstance(uri, str) and uri:
            details.append(f"uri={uri}")
        suffix = f" ({', '.join(details)})" if details else ""
        raise MpcClientError(f"OAuth error: {err}{suffix}")

    code = callback.get("code")
    if not code:
        raise MpcClientError("OAuth callback did not include a code")

    token_payload = _oauth_exchange_code(
        token_endpoint=token_endpoint,
        client_id=client_id,
        code=code,
        redirect_uri=redirect_uri,
        code_verifier=code_verifier,
        timeout_seconds=args.timeout,
    )

    access_token = token_payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise MpcClientError(
            f"token response missing access_token: {json.dumps(token_payload, ensure_ascii=True)}"
        )

    token_payload["client_id"] = client_id
    if args.scope:
        token_payload["scope_requested"] = args.scope
    _save_token(args.token_file, token_payload)

    print(f"Saved token to {args.token_file}")

    if args.print_token:
        print(access_token)
    return 0


def _cmd_logout(args: argparse.Namespace) -> int:
    if os.path.exists(args.token_file):
        os.remove(args.token_file)
        print(f"Removed token file: {args.token_file}")
    else:
        print(f"No token file found: {args.token_file}")
    return 0


def _cmd_token_set(args: argparse.Namespace) -> int:
    token = args.access_token.strip()
    if not token:
        raise MpcClientError("access token cannot be empty")

    payload: dict[str, Any] = {
        "access_token": token,
        "token_type": "Bearer",
    }
    if args.scope:
        payload["scope"] = args.scope
    if args.expires_in is not None:
        payload["expires_in"] = args.expires_in

    _save_token(args.token_file, payload)
    print(f"Saved token to {args.token_file}")
    return 0


def _cmd_token_show(args: argparse.Namespace) -> int:
    payload = _read_saved_token(args.token_file)
    if not payload:
        raise MpcClientError(f"no token file found at {args.token_file}")

    if not args.reveal and "access_token" in payload:
        token_val = payload.get("access_token")
        if isinstance(token_val, str):
            if len(token_val) > 12:
                payload["access_token"] = f"{token_val[:6]}...{token_val[-4:]}"
            else:
                payload["access_token"] = "***"

    _print_json(payload)
    return 0


def _cmd_token_clear(args: argparse.Namespace) -> int:
    return _cmd_logout(args)


def _cmd_audit(client: StreamableHttpMcpClient, args: argparse.Namespace) -> int:
    report: dict[str, Any] = {
        "url": client.url,
        "discover": {"ok": False, "error": None},
        "initialize": {"ok": False, "error": None},
        "tools_list": {"ok": False, "error": None},
        "who_am_i": {"ok": False, "error": None},
        "token_file": args.token_file,
        "notes": [],
    }

    try:
        discover = client.discover()
        report["discover"]["ok"] = True
        if isinstance(discover, dict):
            report["discover"]["tool_count"] = len(discover.get("tools", []))
            auth = discover.get("auth")
            if isinstance(auth, dict):
                report["discover"]["auth_type"] = auth.get("type")
    except Exception as exc:  # pylint: disable=broad-except
        report["discover"]["error"] = str(exc)

    if not client.token:
        report["notes"].append("No bearer token provided or saved; initialize/calls skipped.")
        _print_json(report)
        return 0

    try:
        client.initialize()
        report["initialize"]["ok"] = True
    except Exception as exc:  # pylint: disable=broad-except
        report["initialize"]["error"] = str(exc)
        _print_json(report)
        return 0

    try:
        tools_result = client.tools_list()
        report["tools_list"]["ok"] = True
        report["tools_list"]["count"] = len(tools_result.get("tools", []))
    except Exception as exc:  # pylint: disable=broad-except
        report["tools_list"]["error"] = str(exc)

    try:
        who_result = client.tool_call("who_am_i", {})
        report["who_am_i"]["ok"] = True
        report["who_am_i"]["result"] = who_result
    except Exception as exc:  # pylint: disable=broad-except
        report["who_am_i"]["error"] = str(exc)

    _print_json(report)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pbp-mcp", description="Direct PbP MCP client")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--token", default=None)
    parser.add_argument("--token-file", default=os.getenv("PBP_TOKEN_FILE", _default_token_file()))
    parser.add_argument("--timeout", type=int, default=30)

    subparsers = parser.add_subparsers(dest="command", required=True)

    tools = subparsers.add_parser("tools", help="List tools from discovery endpoint")
    tools.add_argument("--json", action="store_true", help="Print full tools JSON")

    call = subparsers.add_parser("call", help="Call an MCP tool directly")
    call.add_argument("tool_name")
    call.add_argument("--args", default="{}", help="JSON object arguments")

    subparsers.add_parser("whoami", help="Call who_am_i tool")

    login = subparsers.add_parser("login", help="Run OAuth PKCE flow and save token")
    login.add_argument("--scope", default=None)
    login.add_argument("--client-id", default=None)
    login.add_argument("--auth-endpoint", default=None)
    login.add_argument("--token-endpoint", default=None)
    login.add_argument("--registration-endpoint", default=None)
    login.add_argument("--login-timeout", type=int, default=180)
    login.add_argument("--no-browser", action="store_true")
    login.add_argument("--print-token", action="store_true")

    subparsers.add_parser("logout", help="Delete saved token file")
    token_set = subparsers.add_parser(
        "token-set", help="Manually save access token to token file"
    )
    token_set.add_argument("access_token")
    token_set.add_argument("--scope", default=None)
    token_set.add_argument("--expires-in", type=int, default=None)

    token_show = subparsers.add_parser(
        "token-show", help="Show saved token metadata (masked by default)"
    )
    token_show.add_argument("--reveal", action="store_true")

    subparsers.add_parser("token-clear", help="Delete saved token file")
    subparsers.add_parser("audit", help="Run connectivity/auth audit")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    token = _resolve_token(args.token, args.token_file)
    metrics = UsageMetrics()
    client = StreamableHttpMcpClient(args.url, token, args.timeout, metrics=metrics)
    started = time.perf_counter()
    exit_code = 0

    try:
        if args.command == "tools":
            exit_code = _cmd_tools(client, args)
            return exit_code
        if args.command == "call":
            exit_code = _cmd_call(client, args)
            return exit_code
        if args.command == "whoami":
            exit_code = _cmd_whoami(client, args)
            return exit_code
        if args.command == "login":
            exit_code = _cmd_login(client, args)
            return exit_code
        if args.command == "logout":
            exit_code = _cmd_logout(args)
            return exit_code
        if args.command == "token-set":
            exit_code = _cmd_token_set(args)
            return exit_code
        if args.command == "token-show":
            exit_code = _cmd_token_show(args)
            return exit_code
        if args.command == "token-clear":
            exit_code = _cmd_token_clear(args)
            return exit_code
        if args.command == "audit":
            exit_code = _cmd_audit(client, args)
            return exit_code
        parser.error(f"unknown command {args.command}")
    except (MpcClientError, json.JSONDecodeError, socket.timeout, TimeoutError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        exit_code = 2
        return exit_code
    finally:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        _print_usage(metrics, elapsed_ms)


if __name__ == "__main__":
    raise SystemExit(main())
