import asyncio
import json
from telethon import TelegramClient
from telethon.tl.functions.help import GetCountriesListRequest

# Public Telegram API keys (common dummy ones or from official apps)
API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"

async def main():
    client = TelegramClient('anon', API_ID, API_HASH)
    await client.connect()
    
    # We don't even need to login for some help.* methods
    try:
        result = await client(GetCountriesListRequest(
            lang_code='en',
            hash=0
        ))
        
        countries = []
        for country in result.countries:
            codes = []
            for code in country.country_codes:
                codes.append({
                    "country_code": code.country_code,
                    "prefixes": code.prefixes if code.prefixes else [],
                    "patterns": code.patterns if code.patterns else []
                })
            
            countries.append({
                "hidden": country.hidden,
                "iso2": country.iso2,
                "default_name": country.default_name,
                "name": country.name,
                "country_codes": codes
            })
            
        with open("../self_hosted_version/data/countries.json", "w", encoding="utf-8") as f:
            json.dump(countries, f, indent=2, ensure_ascii=False)
            
        print(f"Successfully fetched {len(countries)} countries!")
    except Exception as e:
        print("Error:", e)
    finally:
        await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())
