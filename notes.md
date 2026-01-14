You can run this script by providing the URL of the server you want to target. In the following example, make sure you replace the Headquarters pizza URL with localhost:3000 if you are running against your development environment, or your production pizza service URL if you are trying to generate the dummy data there.

./generatePizzaData.sh https://pizza-service.yourdomainname.click
Note

If you create your own generatePizzaData.sh file instead of using the existing one, then you might need to set the execution mode of the file by running: chmod +x generatePizzaData.sh

Login as the default admin (a@jwt.com with password admin)
Order a pizza.
Validate that the pizza JWT is valid.
Login as a franchisee (f@jwt.com with password franchisee)
View the franchisee menu and observe that you have received the revenue for the previous pizza purchase.