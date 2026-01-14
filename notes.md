You can run this script by providing the URL of the server you want to target. In the following example, make sure you replace the Headquarters pizza URL with localhost:3000 if you are running against your development environment, or your production pizza service URL if you are trying to generate the dummy data there.

./generatePizzaData.sh https://pizza-service.yourdomainname.click
Note

If you create your own generatePizzaData.sh file instead of using the existing one, then you might need to set the execution mode of the file by running: chmod +x generatePizzaData.sh