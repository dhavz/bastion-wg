"""Builds docs/VPN-User-Guide.pdf.  Usage: build_guide.py <server-ip> <output.pdf>"""
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (KeepTogether, ListFlowable, ListItem, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

SERVER_IP, OUT = sys.argv[1], sys.argv[2]
LOG_WEBSITES = len(sys.argv) > 3 and sys.argv[3] == "yes"

INK = colors.HexColor("#1b2430")
MUTED = colors.HexColor("#5b6675")
ACCENT = colors.HexColor("#88171a")      # WireGuard red
TINT = colors.HexColor("#f6f1ef")
OKBG = colors.HexColor("#eaf5ee")
OKFG = colors.HexColor("#1d6b3a")
RULE = colors.HexColor("#d9dde3")

W = letter[0] - 1.7 * inch  # usable width

S = {
    "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=24, leading=28, textColor=INK),
    "sub": ParagraphStyle("sub", fontName="Helvetica", fontSize=11.5, leading=16, textColor=MUTED),
    "h": ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=INK),
    "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=13, leading=17, textColor=INK, spaceBefore=6, spaceAfter=6),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=10.5, leading=15, textColor=INK),
    "small": ParagraphStyle("small", fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=MUTED),
    "num": ParagraphStyle("num", fontName="Helvetica-Bold", fontSize=15, leading=18, textColor=colors.white, alignment=TA_CENTER),
    "ip": ParagraphStyle("ip", fontName="Courier-Bold", fontSize=20, leading=24, textColor=OKFG, alignment=TA_CENTER),
    "ipcap": ParagraphStyle("ipcap", fontName="Helvetica", fontSize=10, leading=14, textColor=OKFG, alignment=TA_CENTER),
    "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=9.8, leading=13.5, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="Helvetica-Bold", fontSize=9.8, leading=13.5, textColor=INK),
}


def P(text, style="body"):
    return Paragraph(text, S[style])


def bullets(items, ordered=True):
    return ListFlowable(
        [ListItem(P(t), leftIndent=16, spaceAfter=3) for t in items],
        bulletType="1" if ordered else "bullet",
        bulletFontName="Helvetica-Bold" if ordered else "Helvetica",
        bulletFontSize=10.5, bulletColor=ACCENT, leftIndent=16,
        bulletFormat="%s." if ordered else None, start=None if ordered else "•",
    )


def box(flowables, bg=TINT, pad=10):
    t = Table([[flowables]], colWidths=[W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LEFTPADDING", (0, 0), (-1, -1), pad + 2), ("RIGHTPADDING", (0, 0), (-1, -1), pad + 2),
        ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
        ("ROUNDEDCORNERS", [6, 6, 6, 6]),
    ]))
    return t


def step(n, title, content):
    badge = Table([[P(str(n), "num")]], colWidths=[0.42 * inch], rowHeights=[0.42 * inch])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROUNDEDCORNERS", [6, 6, 6, 6]), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    head = Table([[badge, P(f"Step {n}: {title}", "h")]], colWidths=[0.58 * inch, W - 0.58 * inch])
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    body = Table([["", content]], colWidths=[0.58 * inch, W - 0.58 * inch])
    body.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return KeepTogether([head, body, Spacer(1, 16)])


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.line(0.85 * inch, 0.7 * inch, letter[0] - 0.85 * inch, 0.7 * inch)
    canvas.setFont("Helvetica", 8.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.85 * inch, 0.52 * inch, "Bastion - Windows setup guide")
    canvas.drawRightString(letter[0] - 0.85 * inch, 0.52 * inch, f"Page {doc.page}")
    canvas.restoreState()


story = [
    P("Bastion", "title"),
    Spacer(1, 4),
    P("Windows setup guide: install WireGuard, import your profile, connect, and confirm "
      "you are browsing through the Canadian server.", "sub"),
    Spacer(1, 14),
    box([
        P("<b>Before you start</b>"),
        Spacer(1, 4),
        bullets([
            "A Windows 10 or Windows 11 computer where you can approve an administrator prompt.",
            "Your personal profile file, named <b>yourname.conf</b>, which was sent to you. "
            "Save it somewhere easy to find, such as your Desktop.",
            "About five minutes.",
        ], ordered=False),
    ]),
    Spacer(1, 20),

    step(1, "Download WireGuard", [
        bullets([
            "Open your web browser (Edge, Chrome or Firefox).",
            "Go to <b>https://www.wireguard.com/install/</b>",
            "Click <b>Download Windows Installer</b>.",
            "The file <b>wireguard-installer.exe</b> is saved to your <b>Downloads</b> folder.",
        ]),
        Spacer(1, 4),
        P("Only download WireGuard from wireguard.com. Other sites offering it are not official.", "small"),
    ]),

    step(2, "Install", [
        bullets([
            "Open your <b>Downloads</b> folder and double-click <b>wireguard-installer.exe</b>.",
            "When Windows asks <i>Do you want to allow this app to make changes to your device?</i> click <b>Yes</b>.",
            "The installer finishes on its own in a few seconds and the WireGuard window opens.",
        ]),
        Spacer(1, 4),
        P("If the window does not open, click Start, type <b>WireGuard</b> and press Enter.", "small"),
    ]),

    step(3, "Import your profile", [
        bullets([
            "In the WireGuard window, click <b>Import tunnel(s) from file</b>. "
            "(If you do not see that button, click <b>Add Tunnel</b> at the bottom left.)",
            "Browse to where you saved <b>yourname.conf</b>, select it and click <b>Open</b>.",
            "A tunnel with your name now appears in the list on the left.",
        ]),
    ]),

    step(4, "Connect", [
        bullets([
            "Select your tunnel in the list on the left.",
            "Click <b>Activate</b>.",
            "Within a few seconds <b>Status</b> changes to <b>Active</b> and a green shield appears next to the tunnel.",
        ]),
        Spacer(1, 4),
        P("To disconnect, click <b>Deactivate</b>. You can also right-click the WireGuard icon near the "
          "clock (bottom right of the screen) to connect and disconnect.", "small"),
    ]),

    step(5, "Verify your IP address", [
        bullets([
            "With the tunnel <b>Active</b>, open your browser and go to <b>https://whatismyipaddress.com</b>",
            "Check that the IPv4 address shown is exactly:",
        ]),
        Spacer(1, 8),
        box([
            P(SERVER_IP, "ip"),
            Spacer(1, 3),
            P("Provider: DigitalOcean &nbsp;&nbsp;|&nbsp;&nbsp; Location: the city of your server's region", "ipcap"),
        ], bg=OKBG, pad=12),
        Spacer(1, 8),
        P("If you see this address, you are connected and all of your internet traffic is going "
          "through the Canadian server. If you see any other address, the VPN is not active: "
          "go back to Step 4."),
        Spacer(1, 4),
        P("Websites may take a minute to pick up the new location. If a site still shows the old one, "
          "close the browser completely and open it again.", "small"),
    ]),

    P("If something does not work", "h2"),
]

rows = [
    [P("What you see", "cellb"), P("What to do", "cellb")],
    [P("The installer will not run, or you cannot click Yes on the administrator prompt", "cell"),
     P("Your computer is managed and blocks new software. Ask your IT support to install WireGuard, "
       "or use a personal computer.", "cell")],
    [P("Status says Active but websites do not load", "cell"),
     P("Click Deactivate, wait five seconds, click Activate. If it still fails, the network you are on "
       "(some hotels, offices and guest Wi-Fi) may block VPNs. Try a phone hotspot to confirm.", "cell")],
    [P("Step 5 shows a different IP address", "cell"),
     P("The tunnel is not active. Open WireGuard, select your tunnel and click Activate, then refresh the page.", "cell")],
    [P("The connection keeps dropping every few seconds", "cell"),
     P("The same profile is active on two devices at once. Deactivate it on the other device. "
       "Each profile works on one device at a time.", "cell")],
    [P("The import fails with an error", "cell"),
     P("The file was changed or only partly downloaded. Save the original .conf again from the message "
       "you received and import that copy, without opening or editing it.", "cell")],
]
tbl = Table(rows, colWidths=[W * 0.36, W * 0.64], repeatRows=1)
tbl.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), TINT),
    ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
]))
story += [
    tbl,
    Spacer(1, 16),
    KeepTogether([
        P("Keep your profile private", "h2"),
        bullets([
            "Your .conf file is your personal key to the VPN. Do not forward it or share it with anyone.",
            "Use it on one device at a time. If you need the VPN on a second device, ask for a second profile.",
            "If your computer is lost or stolen, tell the VPN administrator so the profile can be revoked.",
            "Deactivate the tunnel when you do not need it.",
        ], ordered=False),
    ]),
]

recorded = [
    "When you connect and disconnect, and the internet address you connect from.",
    "How much data you send and receive.",
]
if LOG_WEBSITES:
    recorded.append("The names of the websites and services your device contacts while connected, "
                    "for example <b>example.com</b>. Page addresses, page content, passwords and "
                    "anything you type are not recorded.")
story += [
    Spacer(1, 10),
    KeepTogether([
        P("What is recorded while you are connected", "h2"),
        P("The VPN administrator can see the following for your profile. Records are deleted automatically "
          "after a set period."),
        Spacer(1, 4),
        bullets(recorded, ordered=False),
        Spacer(1, 4),
        P("Nothing is recorded while the tunnel is deactivated.", "small"),
    ]),
]

doc = SimpleDocTemplate(
    OUT, pagesize=letter,
    leftMargin=0.85 * inch, rightMargin=0.85 * inch, topMargin=0.8 * inch, bottomMargin=0.95 * inch,
    title="Bastion - Windows setup guide", author="VPN administrator",
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f"wrote {OUT}")
