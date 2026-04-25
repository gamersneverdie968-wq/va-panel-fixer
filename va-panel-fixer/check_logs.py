from selenium import webdriver
from selenium.webdriver.edge.options import Options
import time

try:
    options = Options()
    # options.add_argument('--headless')
    driver = webdriver.Edge(options=options)
    driver.get("http://localhost:7890")
    
    time.sleep(2)
    
    print("CONSOLE LOGS:")
    for log in driver.get_log("browser"):
        print(log)
    
    driver.quit()
except Exception as e:
    print(f"Error: {e}")
