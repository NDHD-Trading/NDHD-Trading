"""Username/password sign-in for the dashboard (users live in PostgreSQL,
see ndhd/db.py). The session is an HttpOnly, SameSite=Strict cookie, so page
scripts can't read it and other sites can't send it."""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.exc import SQLAlchemyError

from ndhd import auth, db

from .. import deps
from ..schemas import LoginIn, MeOut

LOGGER = logging.getLogger("dashboard-api")

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _me(principal) -> MeOut:
    if principal is None:
        return MeOut(signed_in=False, users_enabled=deps.users_enabled())
    return MeOut(signed_in=True, users_enabled=deps.users_enabled(), username=principal.username,
                 role=principal.role, sections=sorted(principal.sections), via=principal.via)


def _secure_cookie(request: Request) -> bool:
    forced = os.getenv("SESSION_COOKIE_SECURE", "").strip().lower()
    if forced in ("true", "false"):
        return forced == "true"
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return proto == "https"


def _client_details(request: Request) -> tuple[str, str]:
    """(ip, user agent) for the sign-in log. Behind Tailscale Serve every
    request arrives from localhost, so the proxy's headers say who it really
    was. They are only believed from localhost: anything else could send them
    itself. The dashboard binds to 127.0.0.1, so that's the proxy."""
    ip = request.client.host if request.client else ""
    agent = request.headers.get("user-agent", "")
    if ip in ("127.0.0.1", "::1"):
        forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        ip = forwarded or ip
        who = request.headers.get("tailscale-user-login", "").strip()
        if who:
            agent = f"tailscale:{who} {agent}"
    return ip, agent


@router.post("/login", response_model=MeOut)
def login(body: LoginIn, request: Request, response: Response) -> MeOut:
    if not deps.users_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="Sign-in isn't set up (DATABASE_URL is not set).")
    ip, agent = _client_details(request)
    try:
        with db.session() as s:
            token = auth.login(s, body.username, body.password, ip=ip, user_agent=agent)
            principal = auth.principal_for_token(s, token) if token else None
    except auth.LoginThrottled:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Too many failed sign-ins. Try again in 15 minutes.")
    except SQLAlchemyError as exc:
        LOGGER.error("Sign-in failed, database error: %s", exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database unavailable.")
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Wrong username or password.")

    response.set_cookie(deps.SESSION_COOKIE, token, max_age=int(auth.SESSION_HOURS * 3600), httponly=True,
                        samesite="strict", secure=_secure_cookie(request), path="/")
    return _me(principal)


@router.post("/logout", response_model=MeOut)
def logout(request: Request, response: Response) -> MeOut:
    token = request.cookies.get(deps.SESSION_COOKIE)
    if token and deps.users_enabled():
        try:
            with db.session() as s:
                auth.logout(s, token)
        except SQLAlchemyError as exc:
            LOGGER.error("Sign-out: database error: %s", exc)
    response.delete_cookie(deps.SESSION_COOKIE, path="/")
    return _me(None)


@router.get("/me", response_model=MeOut)
def me(principal=Depends(deps.current_principal)) -> MeOut:
    """Who this browser is signed in as and which sections it may see.
    Always 200, so the page can decide whether to show the sign-in form."""
    return _me(principal)
