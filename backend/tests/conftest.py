import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa


@pytest.fixture(autouse=True)
def _isolate_settings(monkeypatch, tmp_path):
    # Unit tests must not read the developer's real backend/.env.local (its keys
    # would leak into "no key configured" tests). Run each test from a temp cwd
    # with no env file, and give every test a clean settings cache. Tests that
    # need specific values set them with monkeypatch.setenv + cache_clear().
    from app import config

    monkeypatch.chdir(tmp_path)
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


@pytest.fixture(scope="session")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="session")
def public_key(rsa_key):
    return rsa_key.public_key()


@pytest.fixture
def make_token(rsa_key):
    def _make(sub="user-1", aud="authenticated", expired=False, **extra):
        now = int(time.time())
        payload = {
            "sub": sub,
            "aud": aud,
            "exp": now - 60 if expired else now + 3600,
            "iat": now,
            **extra,
        }
        return jwt.encode(payload, rsa_key, algorithm="RS256")

    return _make


@pytest.fixture(autouse=True)
def patch_jwks(monkeypatch, public_key):
    # Replace the network JWKS client with one that returns our test public key.
    class _FakeSigningKey:
        key = public_key

    class _FakeJwkClient:
        def get_signing_key_from_jwt(self, token):
            return _FakeSigningKey()

    from app import auth

    monkeypatch.setattr(auth, "_jwk_client", lambda: _FakeJwkClient())
