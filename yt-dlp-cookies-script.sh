#!/bin/bash

# Function to display usage instructions
usage() {
  echo "Usage: $0"
  echo
  echo "This script loads Firebase credentials from a .env file."
  echo
  echo "Ensure your .env file contains the following format:"
  echo "  EMAIL=your-email@example.com"
  echo "  PASSWORD=your-password"
  echo "  FIREBASE_API_KEY=your-firebase-api-key"
  echo "  FIREBASE_DB_URL=your-firebase-database-url"
  echo
  exit 1
}

# Load environment variables from .env file if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
else
  echo ".env file not found!"
  usage
fi

# Check if required environment variables are loaded
if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$FIREBASE_API_KEY" ] || [ -z "$FIREBASE_DB_URL" ]; then
  echo "EMAIL, PASSWORD, FIREBASE_API_KEY, FIREBASE_DB_URL is not set in the .env file."
  usage
fi

echo "Extracting YouTube cookies from Chrome..."

# Create a temporary file for cookies
# Set environment variables
export DISPLAY=:0  # Set the display number, if necessary
export XAUTHORITY=/home/username/.Xauthority  # Path to the X authority file (if needed)

COOKIES_TEMP=\"$(mktemp cookies_$(date +%s%N).txt)\"
echo "Temporary file created at: $COOKIES_TEMP"

# Extract cookies from Chrome 
$(pwd)/bin/yt-dlp --cookies-from-browser chrome --cookies $COOKIES_TEMP --skip-download --quiet -i 
# # Check if yt-dlp was successful
# if [ $? -ne 0 ]; then
#   echo "Error: Failed to extract cookies from Chrome."
#   rm -f "$COOKIES_TEMP"
#   exit 1
# fi

# Filter only YouTube cookies and encode to base64

YOUTUBE_COOKIES=$(cat "$COOKIES_TEMP" | (head -n 2 "$COOKIES_TEMP"; grep "^\.youtube\.com") | base64)

# Clean up temporary file
rm -f "$COOKIES_TEMP"    # Delete the file with quotes
rm -f ${COOKIES_TEMP//\"/}  # Delete the file without quotes


# Check if we got any cookies
if [ -z "$YOUTUBE_COOKIES" ]; then
  echo "Error: No YouTube cookies found."
  exit 1
fi
echo "Successfully extracted YouTube cookies."

# Get Firebase authentication token
echo "Authenticating with Firebase..."
AUTH_RESPONSE=$(curl --silent --location "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_API_KEY" \
  --header 'Content-Type: application/json' \
  --data-raw "{
    \"email\": \"$EMAIL\",
    \"password\": \"$PASSWORD\",
    \"returnSecureToken\": true
  }")

# Extract ID token
ID_TOKEN=$(echo "$AUTH_RESPONSE" | jq -r '.idToken')

if [ -z "$ID_TOKEN" ]; then
  echo "Error: Failed to authenticate with Firebase. Response:"
  echo "$AUTH_RESPONSE"
  exit 1
fi

echo "Successfully authenticated with Firebase."

# Update Firebase Realtime Database
echo "Uploading cookies to Firebase Realtime Database..."
UPDATE_RESPONSE=$(curl --silent --location "$FIREBASE_DB_URL/yt-dlp-cookies.json?auth=$ID_TOKEN" \
  --header 'Content-Type: application/json' \
  --request PUT \
  --data "\"$YOUTUBE_COOKIES\"")

if [[ "$UPDATE_RESPONSE" == *"error"* ]]; then
  echo "Error: Failed to update Firebase database. Response:"
  echo "$UPDATE_RESPONSE"
  exit 1
fi

echo "Successfully uploaded YouTube cookies to Firebase."
exit 0