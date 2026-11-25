# SOCKS proxy helper (`socks.sh`)

A small, **separate** utility for quick browser-egress testing — unrelated to the VPN server.
It stands up a throwaway droplet running a [Dante](https://www.inet.no/dante/) SOCKS5 proxy
that you can point a browser at, then tears it down.

```
./socks.sh up        # create the droplet and start the proxy
./socks.sh status    # show the address and who may use it
./socks.sh allow     # also allow the network you're on now (or: allow 1.2.3.4)
./socks.sh down      # delete the droplet and its firewall (billing stops)
```

## How access is controlled

The proxy has **no username or password** (browsers can't send credentials to a SOCKS proxy),
so the cloud firewall is the only gate: it allows **only the public IP addresses you list**.
Everyone else is dropped. `./socks.sh up` allows the network you ran it from; add more with
`./socks.sh allow [ip]`.

The proxy listens on **ports 443, 80 and 1080**, so it still works from networks whose egress
only permits 443/80.

## Using it in Firefox

Settings → Network Settings → *Manual proxy configuration*:

| Field | Value |
|---|---|
| SOCKS Host | the address from `./socks.sh status` |
| Port | `443` (try first), or `1080` |
| Type | SOCKS v5 |
| Proxy DNS when using SOCKS v5 | ticked |

Leave the HTTP/HTTPS proxy fields empty.

## Notes

- It is **temporary** — remember to `./socks.sh down` when finished so you stop paying for the
  droplet.
- The hop from your browser to the proxy is plain SOCKS; only sites using HTTPS are protected
  on that leg.
- State is kept in `.state/socks.env` (git-ignored).
