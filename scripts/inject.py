#!/usr/bin/env python3
import json, hmac, hashlib, shutil, time, sys, os, subprocess

def get_device_id():
    result = subprocess.run(['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'],
                           capture_output=True, text=True)
    for line in result.stdout.split('\n'):
        if 'IOPlatformUUID' in line:
            return line.split('=')[1].strip().strip('"')
    raise RuntimeError('Could not get IOPlatformUUID')

def get_chrome_seed():
    seed_path = '/tmp/chrome_pref_hash_seed.bin'
    if os.path.exists(seed_path):
        with open(seed_path, 'rb') as f:
            return f.read()
    return b''

def remove_empty(obj):
    if isinstance(obj, dict):
        result = {}
        for k in sorted(obj.keys()):
            v = remove_empty(obj[k])
            if isinstance(v, dict) and len(v) == 0:
                continue
            if isinstance(v, list) and len(v) == 0:
                continue
            result[k] = v
        return result
    elif isinstance(obj, list):
        return [remove_empty(i) for i in obj
                if not (isinstance(remove_empty(i), (dict, list)) and len(remove_empty(i)) == 0)]
    return obj

def chrome_json(value):
    if value is None:
        return ''
    cleaned = remove_empty(value)
    j = json.dumps(cleaned, separators=(',', ':'), sort_keys=True, ensure_ascii=False)
    return j.replace('<', '\\u003C')

def compute_hmac(seed, device_id, path, value_json):
    msg = (device_id + path + value_json).encode('utf-8')
    return hmac.new(seed, msg, hashlib.sha256).hexdigest().upper()

def get_browser_paths(browser):
    if browser == 'brave':
        return {
            'app': '/Applications/Brave Browser.app',
            'support': os.path.expanduser('~/Library/Application Support/BraveSoftware/Brave-Browser'),
            'nmh': os.path.expanduser('~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
            'name': 'Brave Browser',
        }
    elif browser == 'chrome':
        return {
            'app': '/Applications/Google Chrome.app',
            'support': os.path.expanduser('~/Library/Application Support/Google/Chrome'),
            'nmh': os.path.expanduser('~/Library/Application Support/Google/Chrome/NativeMessagingHosts'),
            'name': 'Google Chrome',
        }
    raise ValueError(f'Unsupported browser: {browser}')

def list_profiles(browser):
    paths = get_browser_paths(browser)
    profiles = []
    support = paths['support']
    for name in sorted(os.listdir(support)):
        prefs_file = os.path.join(support, name, 'Preferences')
        if os.path.isfile(prefs_file):
            try:
                with open(prefs_file) as f:
                    p = json.load(f)
                display = p.get('profile', {}).get('name', '(unnamed)')
                profiles.append({'dir': name, 'name': display})
            except:
                pass
    return profiles

def inject_extension(browser, profile_dir, extension_src, daemon_path):
    paths = get_browser_paths(browser)
    device_id = get_device_id()
    seed = get_chrome_seed() if browser == 'chrome' else b''

    ext_id = 'hkjbaciefhhgekldhncknbjkofbpenng'
    version = None
    with open(os.path.join(extension_src, 'manifest.json')) as f:
        manifest = json.load(f)
        version = manifest['version']

    profile_path = os.path.join(paths['support'], profile_dir)
    prefs_path = os.path.join(profile_path, 'Secure Preferences')

    if not os.path.isfile(prefs_path):
        raise FileNotFoundError(f'Secure Preferences not found at {prefs_path}')

    # 1. Copy extension files
    ext_dst = os.path.join(profile_path, 'Extensions', ext_id, f'{version}_0')
    os.makedirs(ext_dst, exist_ok=True)
    for item in os.listdir(extension_src):
        src = os.path.join(extension_src, item)
        dst = os.path.join(ext_dst, item)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)

    # 2. Load and modify Secure Preferences
    with open(prefs_path) as f:
        prefs = json.load(f)

    install_time = str(int(time.time() * 1000000) + 11644473600000000)

    entry = {
        'account_extension_type': 0,
        'active_bit': True,
        'active_permissions': {
            'api': manifest.get('permissions', []),
            'explicit_host': manifest.get('host_permissions', []),
            'manifest_permissions': [],
            'scriptable_host': ['<all_urls>']
        },
        'commands': {},
        'content_settings': [],
        'creation_flags': 38,
        'disable_reasons': [],
        'first_install_time': install_time,
        'from_webstore': False,
        'granted_permissions': {
            'api': manifest.get('permissions', []),
            'explicit_host': manifest.get('host_permissions', []),
            'manifest_permissions': [],
            'scriptable_host': ['<all_urls>']
        },
        'incognito': False,
        'last_update_time': install_time,
        'location': 4,
        'manifest': manifest,
        'path': f'{ext_id}/{version}_0',
        'preferences': {},
        'regular_only_preferences': {},
        'was_installed_by_default': False,
        'was_installed_by_oem': False,
        'withholding_permissions': False
    }

    prefs.setdefault('extensions', {}).setdefault('settings', {})[ext_id] = entry

    # 3. Compute MAC
    path = f'extensions.settings.{ext_id}'
    value_json = chrome_json(entry)
    new_mac = compute_hmac(seed, device_id, path, value_json)
    prefs.setdefault('protection', {}).setdefault('macs', {}).setdefault('extensions', {}).setdefault('settings', {})[ext_id] = new_mac

    # 4. Recompute super_mac
    super_json = chrome_json(prefs['protection']['macs'])
    prefs['protection']['super_mac'] = compute_hmac(seed, device_id, '', super_json)

    # 5. Backup and write
    shutil.copy2(prefs_path, prefs_path + '.pre-interceptor')
    with open(prefs_path, 'w') as f:
        json.dump(prefs, f, separators=(',', ':'), ensure_ascii=False)

    # 6. Install native messaging host
    os.makedirs(paths['nmh'], exist_ok=True)
    abs_daemon = os.path.abspath(daemon_path)
    nmh_manifest = {
        'name': 'com.interceptor.host',
        'description': 'Interceptor native messaging host',
        'path': abs_daemon,
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{ext_id}/']
    }
    nmh_path = os.path.join(paths['nmh'], 'com.interceptor.host.json')
    with open(nmh_path, 'w') as f:
        json.dump(nmh_manifest, f, indent=2)

    return True

if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(description='Inject Interceptor extension')
    p.add_argument('--browser', required=True, choices=['chrome', 'brave'])
    p.add_argument('--profile', required=True)
    p.add_argument('--extension-src', required=True)
    p.add_argument('--daemon-path', required=True)
    p.add_argument('--list-profiles', action='store_true')
    args = p.parse_args()

    if args.list_profiles:
        for prof in list_profiles(args.browser):
            print(f"{prof['dir']}\t{prof['name']}")
        sys.exit(0)

    inject_extension(args.browser, args.profile, args.extension_src, args.daemon_path)
    print('ok')
