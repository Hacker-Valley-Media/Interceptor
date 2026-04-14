# Replay plan for Canva custom-size creation
# Captured from session a23ca61c-0eb2-4855-906b-c7c9593bfba7 on 2026-04-13.
# This reproduces the setup flow only. It does not reproduce later in-editor edits.

interceptor tab new "https://www.canva.com/"
interceptor wait-stable
interceptor click "button:Create a design"
interceptor wait-stable
interceptor click "button:Custom size"
interceptor wait-stable
interceptor type "spinbutton:Width" "640"
interceptor keys "Tab"
interceptor type "spinbutton:Height" "320"
interceptor keys "Tab"
interceptor click "button:Create a design in a new tab or window"

