"""Thin local MCP adapter for the shared report uploader."""
from typing import Literal
from urllib.parse import urlsplit
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from psap_report import ReportError, get_token, upload

server = FastMCP("PSAP Report uploader")


@server.tool()
def upload_report(
    source: str,
    title: str,
    category: Literal["benchmarks", "ci", "investigations", "presentations"],
    entry_file: str | None = None,
    access: Literal["internal", "public"] = "internal",
    tags: str = "",
    description: str = "",
) -> dict[str, str]:
    """Publish a local HTML file or directory with assets as a new report.

    Obtain user approval for the bundle, metadata, and visibility before calling.
    source is on this server's filesystem; relative paths use its working directory.
    Directories require entry_file. tags is comma-separated. Login separately with
    bin/psap-report --login. This tool never starts interactive authorization.
    """
    try:
        result = upload(source, title=title, category=category, entry_file=entry_file,
                        access=access, tags=tags, description=description,
                        token=get_token(interactive=False))
        path = urlsplit(result["path"])
        if path.query or path.fragment or path.username or path.password:
            raise ValueError("Unexpected report path")
        return {"id": str(result["id"]), "path": result["path"]}
    except ReportError as error:
        raise ToolError(error.safe_message) from None
    except Exception:
        raise ToolError("Upload could not finish. Check local file permissions, network access, and API availability. Check the hub before retrying to avoid duplicates.") from None
