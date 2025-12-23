import json
import os
import glob
import urllib.request
import sys

PACKAGES = ["jelka", "jelka_validator"]
CONFIG_FILE = "libraries.json"

def get_latest_wheel_info(package_name):
    print(f"Checking {package_name}...")
    url = f"https://pypi.org/pypi/{package_name}/json"
    
    try:
        with urllib.request.urlopen(url) as response:
            if response.status != 200:
                raise Exception(f"HTTP Error {response.status}")
            
            data = json.loads(response.read().decode('utf-8'))
            version = data["info"]["version"]
            
            # The 'urls' list in PyPI JSON always contains files for the *latest* version
            for file_info in data["urls"]:
                if file_info["packagetype"] == "bdist_wheel":
                    return file_info["url"], file_info["filename"], version
            
            raise Exception(f"No .whl file found for {package_name} {version}")
            
    except Exception as e:
        print(f"Error fetching metadata for {package_name}: {e}")
        sys.exit(1)

def main():
    lib_config = {}

    # 1. Clean old wheels
    print("Cleaning old wheels...")
    # Remove any existing .whl files for these packages
    for pkg in PACKAGES:
        for old_file in glob.glob(f"{pkg}-*.whl"):
            try:
                os.remove(old_file)
            except OSError:
                pass

    # 2. Download new wheels
    for pkg in PACKAGES:
        url, filename, version = get_latest_wheel_info(pkg)
        print(f"Downloading {filename} ({version})...")
        
        try:
            # Download file
            with urllib.request.urlopen(url) as response, open(filename, 'wb') as out_file:
                out_file.write(response.read())
            
            lib_config[pkg] = filename
            
        except Exception as e:
            print(f"Failed to download {filename}: {e}")
            sys.exit(1)

    # 3. Save config for JS to read
    print(f"Updating {CONFIG_FILE}...")
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump(lib_config, f, indent=4)
    except Exception as e:
        print(f"Failed to write config file: {e}")
        sys.exit(1)
        
    print("Done! Web environment updated.")

if __name__ == "__main__":
    main()
