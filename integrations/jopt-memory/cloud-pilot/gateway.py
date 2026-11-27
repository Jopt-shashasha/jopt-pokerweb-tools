"""Expose one Basic Memory project to the authorized pilot account."""

import os

from fastmcp import Client, FastMCP
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.server.auth.auth import AccessToken
from fastmcp.server.auth.providers.google import GoogleProvider
from fastmcp.server.providers.proxy import ProxyProvider
from fastmcp.server.transforms import Visibility

PILOT_TOOLS = {"bm_search", "bm_read", "bm_write", "bm_edit"}


class PilotGoogleProvider(GoogleProvider):
    def __init__(self, allowed_email: str, **kwargs):
        super().__init__(**kwargs)
        self.allowed_email = allowed_email.strip().casefold()
        if not self.allowed_email or "@" not in self.allowed_email:
            raise ValueError("Set PILOT_GOOGLE_EMAIL to one Google account email")

    async def load_access_token(self, token: str) -> AccessToken | None:
        verified = await super().load_access_token(token)
        claims = (verified.claims or {}) if verified else {}
        email = claims.get("email")
        email_verified = claims.get("email_verified")
        if email_verified is not True and email_verified != "true":
            return None
        if not isinstance(email, str) or email.casefold() != self.allowed_email:
            return None
        return verified


def build_server(upstream_url: str, auth: PilotGoogleProvider) -> FastMCP:
    server = FastMCP("JOPT Memory Cloud Pilot", auth=auth)
    provider = ProxyProvider(lambda: Client(StreamableHttpTransport(upstream_url)))
    provider.add_transform(Visibility(False, match_all=True))
    provider.add_transform(Visibility(True, names=PILOT_TOOLS, components={"tool"}))
    server.add_provider(provider)
    return server


if __name__ == "__main__":
    auth = PilotGoogleProvider(
        allowed_email=os.environ["PILOT_GOOGLE_EMAIL"],
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
        base_url=os.environ["MCP_BASE_URL"],
        required_scopes=["openid", "email"],
        forward_resource=False,
        require_authorization_consent=True,
    )
    build_server(os.environ["BASIC_MEMORY_URL"], auth).run(
        transport="http", host="0.0.0.0", port=8000, path="/mcp"
    )
