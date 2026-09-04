from client_credential_api import generate_secret, hash_secret


def test_generate_secret_returns_a_high_entropy_string():
    secret = generate_secret()

    assert isinstance(secret, str)
    assert len(secret) > 30


def test_generate_secret_returns_a_different_value_each_call():
    assert generate_secret() != generate_secret()


def test_hash_secret_is_deterministic_for_the_same_input():
    secret = generate_secret()

    assert hash_secret(secret) == hash_secret(secret)


def test_hash_secret_differs_for_different_secrets():
    assert hash_secret("secret-a") != hash_secret("secret-b")


def test_hash_secret_never_returns_the_raw_secret():
    secret = "a-plain-text-secret"

    assert hash_secret(secret) != secret
