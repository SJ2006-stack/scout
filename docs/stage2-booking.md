# Stage 2 booking note

Stage 1 does not book anything. A card opens the Luma, District, or BookMyShow page, and the person finishes seats and payment there.

A later booking step can be added only after Luma or District provides an authorized booking API for this use.

1. The person picks a card from the Stage 1 list.
2. Scout requests the current price, time, and availability from that authorized API.
3. Scout shows a preview: title, time, venue, ticket count, fees, and total.
4. The person confirms that exact total. A change in total, time, or ticket count requires a new confirmation.
5. Payment starts only through the merchant's supported flow. For UPI, the person approves the payment in their own UPI app. Scout does not ask for or store a UPI PIN.
6. Scout shows a receipt only after the provider confirms the booking. A button click is not a confirmation. A timeout stays unresolved and is not retried as a new purchase.

If neither platform offers that API, Stage 1 links remain the way to book. Scout does not bypass CAPTCHA, queues, login challenges, or bot checks, and it does not call checkout, order, or payment pages on its own.
